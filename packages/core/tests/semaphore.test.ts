import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RedisSemaphoreLease,
  SemaphoreOperationError,
  waitForSemaphore,
  type SemaphoreRedis,
} from '../src/runtime/semaphore.js';
import { isJobExecutionCleanupFailure } from '../src/runtime/job-execution.js';

const url = process.env.SIDEDOOR_TEST_REDIS_URL;
const execute = promisify(execFile);
describe.skipIf(!url)('Redis semaphore token ownership', () => {
  const keys = new Set<string>();
  const redis: SemaphoreRedis = {
    async eval(script, inputKeys, args) {
      const { stdout } = await execute('redis-cli', [
        '-u',
        url!,
        '--json',
        'EVAL',
        script,
        String(inputKeys.length),
        ...inputKeys,
        ...args,
      ]);
      return JSON.parse(stdout) as unknown;
    },
  };
  function lease(
    resource: string,
    options: { ttlMs?: number; limit?: number; port?: SemaphoreRedis; token?: string } = {},
  ) {
    const result = new RedisSemaphoreLease(options.port ?? redis, {
      namespace: 'sidedoor-test',
      resource,
      limit: options.limit ?? 1,
      ttlMs: options.ttlMs ?? 5000,
      token: options.token,
    });
    keys.add(result.key);
    return result;
  }
  afterEach(async () => {
    if (keys.size) await execute('redis-cli', ['-u', url!, 'DEL', ...keys]);
    keys.clear();
  });

  it('enforces capacity across concurrent callers and duplicate acquisition', async () => {
    const resource = randomUUID();
    const contenders = Array.from({ length: 12 }, () => lease(resource, { limit: 3 }));
    const acquired = await Promise.all(contenders.map((item) => item.acquire()));
    expect(acquired.filter(Boolean)).toHaveLength(3);
    const holders = contenders.filter((_, index) => acquired[index]);
    expect(await Promise.all(holders.map((item) => item.acquire()))).toEqual([true, true, true]);
    await holders[0]!.release();
    expect(await lease(resource, { limit: 3 }).acquire()).toBe(true);
    expect(await lease(resource, { limit: 3 }).acquire()).toBe(false);
  });

  it.each(['acquire', 'release'] as const)(
    'recovers accepted %s with a lost response using the original token',
    async (operation) => {
      let drop = true;
      const resource = randomUUID();
      const holder = lease(resource, {
        port: {
          async eval(script, inputKeys, args) {
            const result = await redis.eval(script, inputKeys, args);
            if (args[1] === operation && drop) {
              drop = false;
              throw new Error('Response lost');
            }
            return result;
          },
        },
      });
      if (operation === 'acquire') {
        await expect(holder.acquire()).rejects.toBeInstanceOf(SemaphoreOperationError);
        expect(await holder.inspect()).not.toBeNull();
        expect(await holder.acquire()).toBe(true);
        expect(await lease(resource).acquire()).toBe(false);
      } else {
        expect(await holder.acquire()).toBe(true);
        await expect(holder.release()).rejects.toBeInstanceOf(SemaphoreOperationError);
        const replacement = lease(resource);
        expect(await replacement.acquire()).toBe(true);
        await holder.release();
        expect(await replacement.inspect()).not.toBeNull();
        expect(await lease(resource).acquire()).toBe(false);
      }
    },
  );

  it('an expired holder cannot release a replacement or renew its expired slot', async () => {
    const resource = randomUUID();
    const old = lease(resource, { ttlMs: 20 });
    expect(await old.acquire()).toBe(true);
    await delay(30);
    expect(await old.renew()).toBe(false);
    const replacement = lease(resource);
    expect(await replacement.acquire()).toBe(true);
    await old.release();
    expect(await replacement.inspect()).not.toBeNull();
    expect(await lease(resource).acquire()).toBe(false);
  });

  it('preserves a holder when renewal fails and reports the uncertain operation', async () => {
    const resource = randomUUID();
    const holder = lease(resource, {
      port: {
        async eval(script, inputKeys, args) {
          if (args[1] === 'renew') throw new Error('Redis unavailable');
          return redis.eval(script, inputKeys, args);
        },
      },
    });
    expect(await holder.acquire()).toBe(true);
    await expect(holder.renew()).rejects.toMatchObject({ operation: 'renew', token: holder.token });
    expect(await holder.inspect()).not.toBeNull();
    expect(await lease(resource).acquire()).toBe(false);
  });

  it.each([false, true])(
    'releases the original token when cancellation arrives during acquisition, lost response %s',
    async (lostResponse) => {
      const resource = randomUUID();
      const controller = new AbortController();
      const cancellation = new Error('Cancelled');
      const holder = lease(resource, {
        port: {
          async eval(script, inputKeys, args) {
            const result = await redis.eval(script, inputKeys, args);
            if (args[1] === 'acquire') {
              controller.abort(cancellation);
              if (lostResponse) throw new Error('Acquisition response lost');
            }
            return result;
          },
        },
      });
      const error = await waitForSemaphore(holder, { signal: controller.signal, delaysMs: [10] }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      if (!lostResponse) expect(error).toBe(cancellation);
      expect(await holder.inspect()).toBeNull();
      expect(await lease(resource).acquire()).toBe(true);
    },
  );

  it('interrupts a long capacity wait without disturbing the active holder', async () => {
    const resource = randomUUID();
    const owner = lease(resource);
    expect(await owner.acquire()).toBe(true);
    const controller = new AbortController();
    const waiter = lease(resource, {
      port: {
        async eval(script, inputKeys, args) {
          const result = await redis.eval(script, inputKeys, args);
          if (args[1] === 'acquire') setTimeout(() => controller.abort(new Error('Stop waiting')), 10);
          return result;
        },
      },
    });
    await expect(
      waitForSemaphore(waiter, { signal: controller.signal, delaysMs: [60000] }),
    ).rejects.toThrow();
    expect(await owner.inspect()).not.toBeNull();
    expect(await waiter.inspect()).toBeNull();
  });

  it('preserves unresolved release as execution cleanup failure', async () => {
    const resource = randomUUID();
    const controller = new AbortController();
    const holder = lease(resource, {
      port: {
        async eval(script, inputKeys, args) {
          if (args[1] === 'release') throw new Error('Redis unavailable');
          const result = await redis.eval(script, inputKeys, args);
          controller.abort(new Error('Cancelled'));
          return result;
        },
      },
    });
    const error = await waitForSemaphore(holder, { signal: controller.signal, delaysMs: [] }).catch(
      (caught: unknown) => caught,
    );
    expect(isJobExecutionCleanupFailure(error)).toBe(true);
    expect(await lease(resource).acquire()).toBe(false);
  });
  it('rejects a malformed release acknowledgement instead of confirming cleanup', async () => {
    const holder = lease(randomUUID(), { port: { eval: async () => 0 } });
    await expect(holder.release()).rejects.toMatchObject({ operation: 'release', token: holder.token });
  });
});
