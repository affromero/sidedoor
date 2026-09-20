import {
  RedisSemaphoreLease,
  SemaphoreCleanupError,
  type SemaphoreRedis,
  waitForSemaphore,
} from './semaphore';

export interface SemaphoreConnectionPort extends SemaphoreRedis {
  connect(): Promise<void>;
  end(): Promise<void>;
  onError(listener: (error: Error) => void): () => void;
  onEnd(listener: () => void): () => void;
}

async function bounded<Result>(operation: Promise<Result>, ms: number): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Result>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Redis session deadline exceeded')), ms);
      operation.then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Own an unused connection with reconnect, offline queuing and command replay disabled. */
export async function openSemaphoreSession(
  client: SemaphoreConnectionPort,
  options: {
    namespace: string;
    resource: string;
    limit: number;
    ttlMs: number;
    connectMs: number;
    commandMs: number;
    closeMs: number;
  },
) {
  const { connectMs, commandMs, closeMs } = options;
  for (const value of [connectMs, commandMs, closeMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60000)
      throw new Error('Invalid Redis session deadline');
  }
  const connect = client.connect.bind(client);
  const end = client.end.bind(client);
  const evaluate = client.eval.bind(client);
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  let releaseConfirmed = false;
  const poison = (error: Error) => {
    failure ??= error;
  };

  async function close() {
    poison(new Error('Redis session is closing'));
    closing ??= connecting
      .catch(() => undefined)
      .then(end)
      .then(() => {
        removeError();
        removeEnd();
      });
    await bounded(closing, closeMs);
  }

  const lease = new RedisSemaphoreLease(
    {
      async eval(script, keys, args) {
        if (failure) throw failure;
        try {
          const result = await bounded(
            Promise.resolve().then(() => {
              if (failure) throw failure;
              return evaluate(script, keys, args);
            }),
            commandMs,
          );
          if (failure) throw failure;
          if (args[1] === 'release' && result === 1) releaseConfirmed = true;
          return result;
        } catch (error) {
          poison(error instanceof Error ? error : new Error('Redis command failed', { cause: error }));
          try {
            await close();
          } catch (cleanup) {
            throw new SemaphoreCleanupError(lease.key, lease.token, [error, cleanup], { cause: error });
          }
          throw error;
        }
      },
    },
    options,
  );

  const removeError = client.onError(poison);
  const removeEnd = client.onEnd(() => poison(new Error('Redis session ended')));
  const connecting = Promise.resolve().then(connect);

  async function release() {
    const errors: unknown[] = [];
    if (!releaseConfirmed) {
      try {
        await lease.release();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new SemaphoreCleanupError(lease.key, lease.token, errors, { cause: errors[0] });
  }

  try {
    await bounded(connecting, connectMs);
    if (failure) throw failure;
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new SemaphoreCleanupError(lease.key, lease.token, [error, cleanup], { cause: error });
    }
    throw error;
  }

  return {
    token: lease.token,
    key: lease.key,
    acquire: () => lease.acquire(),
    inspect: () => lease.inspect(),
    renew: () => lease.renew(),
    release,
    async wait(waitOptions: Parameters<typeof waitForSemaphore>[1]) {
      try {
        const acquired = await waitForSemaphore(lease, waitOptions);
        if (!acquired) await close();
        return acquired;
      } catch (error) {
        try {
          await close();
        } catch (cleanup) {
          throw new SemaphoreCleanupError(lease.key, lease.token, [error, cleanup], { cause: error });
        }
        throw error;
      }
    },
  };
}
