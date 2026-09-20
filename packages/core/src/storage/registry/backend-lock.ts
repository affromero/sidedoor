import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SqlExecutor } from '../sql/sql';

export interface DedicatedBackendConnection extends SqlExecutor {
  /** Report errors and unexpected closure, including an already-failed session immediately. */
  onLoss(listener: (error: Error) => void): () => void;
  /** Confirm session termination. Bound failure explicitly; never return this session to a pool. */
  close(): Promise<void>;
}
export interface BackendLock {
  readonly signal: AbortSignal;
  assertHeld(): void;
  /** Release only after dispatched I/O settles or durable uncertainty blocks its successor. */
  release(): Promise<void>;
}

/**
 * Acquire a PostgreSQL session lock on a newly owned dedicated connection.
 * This lock does not replace the cleanup execution journal or remote settlement evidence.
 * The acquisition signal stops admission only. Cleanup owns an independent lifetime.
 * The adapter must bound opening, queries and closure, retaining an error listener until closed.
 */
export async function acquirePostgresBackendLock(options: {
  namespace: string;
  binding: string;
  signal?: AbortSignal;
  openConnection(): Promise<DedicatedBackendConnection>;
}): Promise<BackendLock> {
  const namespace = z.string().min(1).max(200).parse(options.namespace);
  const binding = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(options.binding);
  const acquisitionSignal = options.signal;
  const openConnection = options.openConnection;
  acquisitionSignal?.throwIfAborted();
  const key = createHash('sha256')
    .update(JSON.stringify(['sidedoor-cleanup', namespace, binding]))
    .digest()
    .readBigInt64BE()
    .toString();
  const connection = await openConnection();
  const lifetime = new AbortController();
  let unsubscribe: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  function release(): Promise<void> {
    if (closing) return closing;
    lifetime.abort(new Error('Backend lock was released'));
    closing = (async () => {
      await connection.close();
      unsubscribe?.();
    })();
    return closing;
  }
  try {
    unsubscribe = connection.onLoss((error) => lifetime.abort(error));
    acquisitionSignal?.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const rows = await connection.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key]);
    acquisitionSignal?.throwIfAborted();
    lifetime.signal.throwIfAborted();
    if (rows.length !== 1 || rows[0]?.acquired !== true)
      throw new Error('Storage backend is owned by another cleanup connection');
    return {
      signal: lifetime.signal,
      assertHeld: () => lifetime.signal.throwIfAborted(),
      release,
    };
  } catch (error) {
    try {
      await release();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Backend lock acquisition and closure failed', {
        cause: closeError,
      });
    }
    throw error;
  }
}
