import { expect, it } from 'vitest';
import {
  acquirePostgresBackendLock,
  type DedicatedBackendConnection,
} from '../../../src/storage/registry/backend-lock';

function fixture(acquired = true) {
  let listener: ((error: Error) => void) | undefined;
  let closed = false;
  const connection: DedicatedBackendConnection = {
    query: async () => [{ acquired }],
    onLoss: (notify) => {
      listener = notify;
      return () => {
        listener = undefined;
      };
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    connection,
    closed: () => closed,
    lose: (error: Error) => listener?.(error),
    options: { namespace: 'app', binding: 'a'.repeat(64), openConnection: async () => connection },
  };
}

it('signals connection loss and rejects further dispatch through its ownership assertion', async () => {
  const item = fixture();
  const lock = await acquirePostgresBackendLock(item.options);
  lock.assertHeld();
  const failure = new Error('PostgreSQL connection lost');
  item.lose(failure);
  expect(lock.signal.reason).toBe(failure);
  expect(() => lock.assertHeld()).toThrow(failure);
  await lock.release();
  expect(item.closed()).toBe(true);
});

it('closes a dedicated connection when another owner holds the backend lock', async () => {
  const item = fixture(false);
  await expect(acquirePostgresBackendLock(item.options)).rejects.toThrow('owned by another');
  expect(item.closed()).toBe(true);
});

it('closes an acquired connection when the caller cancelled while it was opening', async () => {
  const item = fixture();
  const controller = new AbortController();
  const reason = new Error('Cancelled admission');
  await expect(
    acquirePostgresBackendLock({
      ...item.options,
      signal: controller.signal,
      openConnection: async () => {
        controller.abort(reason);
        return item.connection;
      },
    }),
  ).rejects.toBe(reason);
  expect(item.closed()).toBe(true);
});

it('keeps cleanup lifetime independent of cancellation after acquisition', async () => {
  const item = fixture();
  const controller = new AbortController();
  const lock = await acquirePostgresBackendLock({ ...item.options, signal: controller.signal });
  controller.abort();
  expect(lock.signal.aborted).toBe(false);
  await lock.release();
  expect(lock.signal.aborted).toBe(true);
  await lock.release();
  expect(item.closed()).toBe(true);
});

it('excludes cleanup in another namespace for the same physical backend', async () => {
  const held = new Set<string>();
  const openConnection = async (): Promise<DedicatedBackendConnection> => {
    let key: string | undefined;
    return {
      async query(sql, values) {
        if (!sql.includes('pg_try_advisory_lock')) throw new Error('Unexpected backend lock query');
        const requested = String(values[0]);
        if (held.has(requested)) return [{ acquired: false }];
        key = requested;
        held.add(requested);
        return [{ acquired: true }];
      },
      onLoss: () => () => {},
      async close() {
        if (key) held.delete(key);
      },
    };
  };
  const binding = 'a'.repeat(64);
  const first = await acquirePostgresBackendLock({ namespace: 'first', binding, openConnection });
  try {
    await expect(
      acquirePostgresBackendLock({ namespace: 'second', binding, openConnection }),
    ).rejects.toThrow('owned by another');
  } finally {
    await first.release();
  }
  const second = await acquirePostgresBackendLock({ namespace: 'second', binding, openConnection });
  await second.release();
});
