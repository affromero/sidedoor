import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
export { openSemaphoreSession, type SemaphoreConnectionPort } from './semaphore-connection';

/** Commands must execute in order on one Redis connection, without replay after release. */
export interface SemaphoreRedis {
  eval(script: string, keys: readonly string[], args: readonly string[]): Promise<unknown>;
}

const script = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local token = ARGV[1]
local operation = ARGV[2]
if operation == 'release' then
  redis.call('ZREM', KEYS[1], token)
  return 1
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local existing = redis.call('ZSCORE', KEYS[1], token)
if operation == 'inspect' then return existing and tonumber(existing) or 0 end
if operation == 'acquire' and existing then return tonumber(existing) end
if operation == 'renew' and not existing then return 0 end
if operation == 'acquire' and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
local expires = now + tonumber(ARGV[4])
redis.call('ZADD', KEYS[1], expires, token)
local latest = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
redis.call('PEXPIREAT', KEYS[1], latest[2])
return expires
`;

export class SemaphoreOperationError extends Error {
  constructor(
    readonly operation: string,
    readonly key: string,
    readonly token: string,
    options: ErrorOptions,
  ) {
    super(`Semaphore ${operation} outcome is unknown`, options);
    this.name = 'SemaphoreOperationError';
  }
}

export class SemaphoreCleanupError extends AggregateError {
  constructor(
    readonly key: string,
    readonly token: string,
    errors: readonly unknown[],
    options: ErrorOptions,
  ) {
    super(errors, 'Semaphore release could not be confirmed', options);
    this.name = 'SemaphoreCleanupError';
  }
}

/**
 * Advisory capacity only. Expiration never proves an external operation has stopped.
 * A token belongs to one logical execution and one handle. Never share it across
 * handles or reuse it for later work, including after expiration or release.
 */
export class RedisSemaphoreLease {
  readonly token: string;
  readonly key: string;
  readonly #redis: SemaphoreRedis;
  readonly #limit: number;
  readonly #ttlMs: number;
  #released = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    redis: SemaphoreRedis,
    options: { namespace: string; resource: string; limit: number; ttlMs: number; token?: string },
  ) {
    if (!options.namespace || !options.resource)
      throw new Error('Semaphore namespace and resource are required');
    if (!Number.isSafeInteger(options.limit) || options.limit < 1)
      throw new Error('Semaphore capacity must be a positive integer');
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 86400000)
      throw new Error('Semaphore lifetime must be between one millisecond and one day');
    const token = options.token ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(token)) throw new Error('Invalid semaphore token');
    this.token = token;
    this.key = `${options.namespace}:semaphore:v1:${Buffer.from(options.resource).toString('base64url')}`;
    this.#redis = { eval: redis.eval.bind(redis) };
    this.#limit = options.limit;
    this.#ttlMs = options.ttlMs;
  }

  #execute(operation: 'acquire' | 'renew' | 'inspect' | 'release'): Promise<number> {
    const run = this.#tail.then(async () => {
      if (this.#released && operation !== 'release' && operation !== 'inspect')
        throw new Error('Released semaphore tokens cannot be acquired or renewed');
      if (operation === 'release') this.#released = true;
      try {
        const result = await this.#redis.eval(
          script,
          [this.key],
          [this.token, operation, String(this.#limit), String(this.#ttlMs)],
        );
        if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0)
          throw new Error('Invalid Redis semaphore response');
        if (operation === 'release' && result !== 1)
          throw new Error('Invalid Redis semaphore release acknowledgement');
        return result;
      } catch (error) {
        throw new SemaphoreOperationError(operation, this.key, this.token, { cause: error });
      }
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** A rejected response can be reconciled by repeating this call with this same token. */
  async acquire(): Promise<boolean> {
    return (await this.#execute('acquire')) > 0;
  }
  async renew(): Promise<boolean> {
    return (await this.#execute('renew')) > 0;
  }
  async inspect(): Promise<{ expiresAt: number } | null> {
    const expiresAt = await this.#execute('inspect');
    return expiresAt === 0 ? null : { expiresAt };
  }
  /** Repeat after an unknown response. It can never release another token's slot. */
  async release(): Promise<void> {
    await this.#execute('release');
  }
}

/** Waiting owns the original token until successful admission or confirmed release. */
export async function waitForSemaphore(
  lease: RedisSemaphoreLease,
  options: {
    signal?: AbortSignal;
    delaysMs: readonly number[];
    shouldStop?: () => Promise<boolean>;
  },
): Promise<boolean> {
  const { signal, shouldStop } = options;
  const delaysMs = [...options.delaysMs];
  try {
    if (delaysMs.some((value) => !Number.isSafeInteger(value) || value < 0))
      throw new Error('Invalid semaphore retry delay');
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      signal?.throwIfAborted();
      if (shouldStop && (await shouldStop())) {
        await lease.release();
        return false;
      }
      signal?.throwIfAborted();
      // Never race acquisition against cancellation: a late acquired token must be released.
      const acquired = await lease.acquire();
      signal?.throwIfAborted();
      if (acquired) return true;
      if (attempt < delaysMs.length) await delay(delaysMs[attempt], undefined, { signal });
    }
    await lease.release();
    return false;
  } catch (error) {
    try {
      await lease.release();
    } catch (cleanup) {
      throw new SemaphoreCleanupError(lease.key, lease.token, [error, cleanup], { cause: error });
    }
    throw error;
  }
}
