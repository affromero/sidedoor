import { expect, it } from 'vitest';
import {
  openPostgresDedicatedConnection,
  PostgresConnectionCleanupError,
  type PostgresClientPort,
} from '../../../src/storage/sql/postgres-connection';
import { acquirePostgresBackendLock } from '../../../src/storage/registry/backend-lock';

const limits = { connectMs: 20, queryMs: 20, closeMs: 20 };
function gate() {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}
function fixture() {
  let errorListener: ((error: Error) => void) | undefined;
  let endListener: (() => void) | undefined;
  let ended = false;
  const port: PostgresClientPort = {
    connect: async () => {
      ended = false;
    },
    query: async () => [{ acquired: true }],
    end: async () => {
      ended = true;
      endListener?.();
    },
    onError(listener) {
      errorListener = listener;
      return () => {
        errorListener = undefined;
      };
    },
    onEnd(listener) {
      endListener = listener;
      return () => {
        endListener = undefined;
      };
    },
  };
  return {
    port,
    ended: () => ended,
    listening: () => Boolean(errorListener),
    error: (error: Error) => errorListener?.(error),
    end: () => endListener?.(),
  };
}

it('reports a connection error that happened before loss subscription', async () => {
  const item = fixture();
  const connection = await openPostgresDedicatedConnection(item.port, limits);
  const reason = new Error('Disconnected');
  item.error(reason);
  item.end();
  let observed: Error | undefined;
  connection.onLoss((error) => {
    observed = error;
  });
  expect(observed).toBe(reason);
  await expect(connection.query('SELECT 1', [])).rejects.toBe(reason);
  await connection.close();
  expect(item.ended()).toBe(true);
});

it.each(['close', 'loss'] as const)('prevents queued SQL dispatch after %s', async (event) => {
  const item = fixture();
  let dispatched = false;
  item.port.query = async () => {
    dispatched = true;
    return [{ acquired: true }];
  };
  const connection = await openPostgresDedicatedConnection(item.port, limits);
  const pending = connection.query('SELECT pg_try_advisory_lock(1)', []);
  const result = expect(pending).rejects.toThrow(event === 'close' ? 'closing' : 'Connection lost');
  if (event === 'close') await connection.close();
  else item.error(new Error('Connection lost'));
  await result;
  expect(dispatched).toBe(false);
  expect(item.ended()).toBe(true);
});

it('closes a late connection after admission timed out without claiming earlier closure', async () => {
  const item = fixture();
  const connecting = gate();
  item.port.connect = () => connecting.promise;
  await expect(openPostgresDedicatedConnection(item.port, limits)).rejects.toMatchObject({
    errors: [expect.any(Error), expect.any(PostgresConnectionCleanupError)],
  });
  expect(item.ended()).toBe(false);
  expect(item.listening()).toBe(true);
  connecting.finish();
  await expect.poll(item.ended).toBe(true);
  expect(item.listening()).toBe(false);
});

it('never returns a usable lock after a timed out query later reports acquisition', async () => {
  const item = fixture();
  const pending = gate();
  item.port.query = async () => {
    await pending.promise;
    return [{ acquired: true }];
  };
  await expect(
    acquirePostgresBackendLock({
      namespace: 'app',
      binding: 'a'.repeat(64),
      openConnection: () => openPostgresDedicatedConnection(item.port, limits),
    }),
  ).rejects.toThrow('query deadline expired');
  expect(item.ended()).toBe(true);
  pending.finish();
});

it('retains observation and a closing continuation when end exceeds its deadline', async () => {
  const item = fixture();
  const ending = gate();
  const end = item.port.end;
  item.port.end = async () => {
    await ending.promise;
    await end();
  };
  const connection = await openPostgresDedicatedConnection(item.port, limits);
  await expect(connection.close()).rejects.toBeInstanceOf(PostgresConnectionCleanupError);
  expect(item.listening()).toBe(true);
  await expect(connection.query('SELECT 1', [])).rejects.toThrow('closing');
  ending.finish();
  await connection.close();
  expect(item.ended()).toBe(true);
  expect(item.listening()).toBe(false);
});
