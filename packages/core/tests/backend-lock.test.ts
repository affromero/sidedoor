import { expect, it } from 'vitest';
import { acquirePostgresBackendLock, type DedicatedBackendConnection } from '../src/storage/backend-lock';

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
