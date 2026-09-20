import { z } from 'zod';
import type { DedicatedBackendConnection } from './backend-lock';
import type { SqlExecutor } from './sql';

export interface PostgresClientPort extends SqlExecutor {
  connect(): Promise<void>;
  end(): Promise<void>;
  onError(listener: (error: Error) => void): () => void;
  onEnd(listener: () => void): () => void;
}
export class PostgresConnectionCleanupError extends Error {
  constructor(options?: ErrorOptions) {
    super('PostgreSQL session closure is unconfirmed', options);
    this.name = 'PostgresConnectionCleanupError';
  }
}
async function bounded<Result>(operation: Promise<Result>, ms: number, message: string): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Result>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      operation.then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Own an unused dedicated client. Never retry queries or return this client to a pool. */
export async function openPostgresDedicatedConnection(
  client: PostgresClientPort,
  timeouts: { connectMs: number; queryMs: number; closeMs: number },
): Promise<DedicatedBackendConnection> {
  const limits = z
    .object({
      connectMs: z.number().int().min(1).max(60_000),
      queryMs: z.number().int().min(1).max(60_000),
      closeMs: z.number().int().min(1).max(60_000),
    })
    .strict()
    .parse(timeouts);
  const connect = client.connect.bind(client);
  const query = client.query.bind(client);
  const end = client.end.bind(client);
  const listeners = new Set<(error: Error) => void>();
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  function lose(error: Error) {
    if (failure) return;
    failure = error;
    for (const listener of listeners) listener(error);
  }
  const removeError = client.onError(lose);
  const removeEnd = client.onEnd(() => lose(new Error('PostgreSQL session ended')));
  const connecting = Promise.resolve().then(connect);
  async function close(): Promise<void> {
    if (!closing) {
      lose(new Error('PostgreSQL session is closing'));
      // A late connect must still be followed by end. Ending before connect settles can be a no-op.
      closing = connecting
        .catch(() => undefined)
        .then(end)
        .then(() => {
          removeError();
          removeEnd();
        });
    }
    try {
      await bounded(closing, limits.closeMs, 'PostgreSQL close deadline expired');
    } catch (error) {
      throw new PostgresConnectionCleanupError({ cause: error });
    }
  }
  async function fail(error: unknown): Promise<never> {
    lose(error instanceof Error ? error : new Error('PostgreSQL operation failed', { cause: error }));
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'PostgreSQL operation and cleanup failed', {
        cause: closeError,
      });
    }
    throw error;
  }
  try {
    await bounded(connecting, limits.connectMs, 'PostgreSQL connect deadline expired');
    if (failure) throw failure;
  } catch (error) {
    return fail(error);
  }
  return {
    onLoss(listener) {
      listeners.add(listener);
      if (failure) listener(failure);
      return () => {
        listeners.delete(listener);
      };
    },
    async query(sql, values) {
      if (failure) throw failure;
      const parameters = [...values];
      try {
        const rows = await bounded(
          Promise.resolve().then(() => {
            if (failure) throw failure;
            return query(sql, parameters);
          }),
          limits.queryMs,
          'PostgreSQL query deadline expired',
        );
        if (failure) throw failure;
        return rows;
      } catch (error) {
        return fail(error);
      }
    },
    close,
  };
}
