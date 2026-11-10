import { z } from 'zod';
import { postgresBackendLockKey, type BackendLock, type DedicatedBackendConnection } from './backend-lock';
import type { SqlExecutor } from '../sql/sql';

export interface BackendLockGroup extends BackendLock {
  /** Run SQL-only work on the same session that holds every backend lock. */
  transaction<Result>(run: (transaction: SqlExecutor) => Promise<Result>): Promise<Result>;
}

/** Hold all physical backend locks on one dedicated session, including through COMMIT. */
export async function acquirePostgresBackendLockGroup(options: {
  bindings: readonly string[];
  signal?: AbortSignal;
  openConnection(): Promise<DedicatedBackendConnection>;
}): Promise<BackendLockGroup> {
  const bindings = z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .min(1)
    .max(1000)
    .parse(options.bindings);
  if (new Set(bindings).size !== bindings.length) throw new Error('Storage backend bindings must be unique');
  bindings.sort();
  options.signal?.throwIfAborted();
  const connection = await options.openConnection();
  const lifetime = new AbortController();
  let unsubscribe: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let running = false;
  function close(): Promise<void> {
    if (closed) return Promise.resolve();
    if (closing) return closing;
    lifetime.abort(new Error('Backend lock group was released'));
    closing = connection
      .close()
      .then(() => {
        closed = true;
        unsubscribe?.();
      })
      .finally(() => {
        closing = undefined;
      });
    return closing;
  }
  try {
    unsubscribe = connection.onLoss((error) => lifetime.abort(error));
    for (const binding of bindings) {
      options.signal?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      const rows = await connection.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [
        postgresBackendLockKey(binding),
      ]);
      lifetime.signal.throwIfAborted();
      if (rows.length !== 1 || rows[0]?.acquired !== true)
        throw new Error('Storage backend is owned by another cleanup connection');
    }
    options.signal?.throwIfAborted();
    lifetime.signal.throwIfAborted();
  } catch (error) {
    try {
      await close();
    } catch (cause) {
      throw new AggregateError([error, cause], 'Backend lock group acquisition and closure failed', {
        cause,
      });
    }
    throw error;
  }
  return {
    signal: lifetime.signal,
    assertHeld: () => lifetime.signal.throwIfAborted(),
    async release() {
      if (running) throw new Error('Cannot release a backend lock group during a transaction');
      await close();
    },
    async transaction<Result>(run: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
      lifetime.signal.throwIfAborted();
      if (running) throw new Error('Backend lock group transaction is already active');
      running = true;
      let begun = false;
      let accepting = false;
      let pending = 0;
      let commitAttempted = false;
      let queryFailed = false;
      let queryError: unknown;
      try {
        await connection.query('BEGIN ISOLATION LEVEL SERIALIZABLE', []);
        begun = true;
        accepting = true;
        const transaction: SqlExecutor = {
          query(sql, values) {
            const operation = (async () => {
              if (!accepting) throw new Error('Backend lock group transaction is no longer active');
              lifetime.signal.throwIfAborted();
              pending++;
              try {
                return await connection.query(sql, values);
              } catch (error) {
                queryFailed = true;
                queryError = error;
                throw error;
              } finally {
                pending--;
              }
            })();
            void operation.catch(() => undefined);
            return operation;
          },
        };
        const result = await run(transaction);
        accepting = false;
        if (pending) throw new Error('Backend lock group transaction has unsettled queries');
        if (queryFailed)
          throw new Error('Backend lock group transaction query failed', { cause: queryError });
        lifetime.signal.throwIfAborted();
        commitAttempted = true;
        await connection.query('COMMIT', []);
        begun = false;
        lifetime.signal.throwIfAborted();
        return result;
      } catch (error) {
        accepting = false;
        let confirmedAbort = false;
        if (begun && commitAttempted && !lifetime.signal.aborted && pending === 0) {
          try {
            confirmedAbort = connection.wasTransactionAborted?.(error) === true;
          } catch {
            // An uncertain classification must close the session.
          }
        }
        if (begun && (!commitAttempted || confirmedAbort) && !lifetime.signal.aborted && pending === 0) {
          try {
            await connection.query('ROLLBACK', []);
            begun = false;
          } catch (cause) {
            try {
              await close();
            } catch (closeError) {
              throw new AggregateError(
                [error, cause, closeError],
                'Backend lock group transaction rollback and closure failed',
                { cause: closeError },
              );
            }
            throw new AggregateError([error, cause], 'Backend lock group transaction rollback failed', {
              cause,
            });
          }
        } else {
          try {
            await close();
          } catch (cause) {
            throw new AggregateError([error, cause], 'Backend lock group transaction closure failed', {
              cause,
            });
          }
        }
        throw error;
      } finally {
        running = false;
      }
    },
  };
}
