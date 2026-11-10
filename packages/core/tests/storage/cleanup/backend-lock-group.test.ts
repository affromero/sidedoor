import { expect, it } from 'vitest';
import { acquirePostgresBackendLockGroup } from '../../../src/storage/registry/backend-lock-group';
import type { DedicatedBackendConnection } from '../../../src/storage/registry/backend-lock';

it('closes the lock session when a commit response is lost', async () => {
  let closed = false;
  const connection: DedicatedBackendConnection = {
    async query(sql) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql === 'COMMIT') throw new Error('commit response lost');
      return [];
    },
    onLoss: () => () => {},
    async close() {
      closed = true;
    },
  };
  const group = await acquirePostgresBackendLockGroup({
    bindings: ['a'.repeat(64)],
    openConnection: async () => connection,
  });
  await expect(group.transaction(async () => undefined)).rejects.toThrow('commit response lost');
  expect(closed).toBe(true);
  await expect(group.transaction(async () => undefined)).rejects.toThrow();
});

it('closes the lock session if rollback after a confirmed commit abort fails', async () => {
  const failure = new Error('server aborted commit');
  let closed = false;
  const connection: DedicatedBackendConnection = {
    async query(sql) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql === 'COMMIT') throw failure;
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return [];
    },
    wasTransactionAborted: (error) => error === failure,
    onLoss: () => () => {},
    async close() {
      closed = true;
    },
  };
  const group = await acquirePostgresBackendLockGroup({
    bindings: ['f'.repeat(64)],
    openConnection: async () => connection,
  });
  const error = await group.transaction(async () => undefined).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([
    failure,
    expect.objectContaining({ message: 'rollback failed' }),
  ]);
  expect(closed).toBe(true);
  await expect(group.transaction(async () => undefined)).rejects.toThrow();
});

it('closes the session when connection loss accompanies a commit abort', async () => {
  const failure = new Error('server aborted commit');
  let onLoss: ((error: Error) => void) | undefined;
  let closed = false;
  const connection: DedicatedBackendConnection = {
    async query(sql) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql === 'COMMIT') {
        onLoss?.(new Error('connection lost'));
        throw failure;
      }
      return [];
    },
    wasTransactionAborted: (error) => error === failure,
    onLoss: (listener) => {
      onLoss = listener;
      return () => {
        onLoss = undefined;
      };
    },
    async close() {
      closed = true;
    },
  };
  const group = await acquirePostgresBackendLockGroup({
    bindings: ['9'.repeat(64)],
    openConnection: async () => connection,
  });
  await expect(group.transaction(async () => undefined)).rejects.toBe(failure);
  expect(closed).toBe(true);
  await expect(group.transaction(async () => undefined)).rejects.toThrow();
});

it('does not commit a transaction after its callback catches a query failure', async () => {
  let committed = false;
  let closed = false;
  const connection: DedicatedBackendConnection = {
    async query(sql) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql === 'BROKEN') throw new Error('query failed');
      if (sql === 'COMMIT') committed = true;
      return [];
    },
    onLoss: () => () => {},
    async close() {
      closed = true;
    },
  };
  const group = await acquirePostgresBackendLockGroup({
    bindings: ['b'.repeat(64)],
    openConnection: async () => connection,
  });
  try {
    await expect(
      group.transaction(async (tx) => {
        try {
          await tx.query('BROKEN', []);
        } catch {
          return;
        }
      }),
    ).rejects.toThrow('transaction query failed');
    expect(committed).toBe(false);
  } finally {
    await group.release();
  }
  expect(closed).toBe(true);
});

it('closes the session when a callback leaves a query unsettled', async () => {
  let closed = false;
  let rejectQuery: ((error: Error) => void) | undefined;
  const connection: DedicatedBackendConnection = {
    async query(sql) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql === 'SLOW')
        return new Promise((_resolve, reject) => {
          rejectQuery = reject;
        });
      return [];
    },
    onLoss: () => () => {},
    async close() {
      closed = true;
      rejectQuery?.(new Error('connection closed'));
    },
  };
  const group = await acquirePostgresBackendLockGroup({
    bindings: ['c'.repeat(64)],
    openConnection: async () => connection,
  });
  await expect(
    group.transaction(async (tx) => {
      void tx.query('SLOW', []);
    }),
  ).rejects.toThrow('unsettled queries');
  expect(closed).toBe(true);
  await expect(group.transaction(async () => undefined)).rejects.toThrow();
});

it('allows confirmation of session closure after a timeout', async () => {
  let attempts = 0;
  const connection: DedicatedBackendConnection = {
    async query(sql) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return [{ acquired: true }];
      return [];
    },
    onLoss: () => () => {},
    async close() {
      attempts++;
      if (attempts === 1) throw new Error('close timed out');
    },
  };
  const group = await acquirePostgresBackendLockGroup({
    bindings: ['d'.repeat(64)],
    openConnection: async () => connection,
  });
  await expect(group.release()).rejects.toThrow('close timed out');
  await expect(group.release()).resolves.toBeUndefined();
  expect(attempts).toBe(2);
});

it('reports rollback and closure failures together', async () => {
  const connection: DedicatedBackendConnection = {
    async query(sql) {
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return [{ acquired: true }];
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return [];
    },
    onLoss: () => () => {},
    async close() {
      throw new Error('close failed');
    },
  };
  const group = await acquirePostgresBackendLockGroup({
    bindings: ['e'.repeat(64)],
    openConnection: async () => connection,
  });
  const error = await group
    .transaction(async () => {
      throw new Error('callback failed');
    })
    .catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.map((cause: Error) => cause.message)).toEqual([
    'callback failed',
    'rollback failed',
    'close failed',
  ]);
});
