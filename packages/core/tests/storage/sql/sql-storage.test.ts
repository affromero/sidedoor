import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { sqlStateBackend, sqlStateRows } from '../../../src/storage/sql/sql';
import { OptimisticStateStore } from '../../../src/storage/sql/optimistic';

const databases: DatabaseSync[] = [];
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(
    'CREATE TABLE "SidedoorState" ("id" TEXT PRIMARY KEY, "revision" TEXT NOT NULL, "state" TEXT NOT NULL)',
  );
  const database = {
    async query(sql: string, values: readonly unknown[]) {
      return db.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  return { db, backend: sqlStateBackend(database, 'sqlite', 'access'), database };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('SQL state persistence', () => {
  it('pages UUID and digest keys while rejecting foreign or malformed cursors', async () => {
    const { database } = fixture();
    const prefix = 'proof:test:';
    const first = `${prefix}00000000-0000-4000-8000-000000000001:${'a'.repeat(64)}`;
    const second = `${prefix}00000000-0000-4000-8000-000000000002:${'b'.repeat(64)}`;
    for (const id of [first, second])
      await sqlStateBackend(database, 'sqlite', id).compareAndSwap(null, { revision: 'one', state: {} });
    expect(
      (await sqlStateRows(database, 'sqlite', prefix, null, 1, 'uuidDigest')).map((row) => row.id),
    ).toEqual([first]);
    expect(
      (await sqlStateRows(database, 'sqlite', prefix, first, 1, 'uuidDigest')).map((row) => row.id),
    ).toEqual([second]);
    await expect(sqlStateRows(database, 'sqlite', prefix, `other:${first}`, 1, 'uuidDigest')).rejects.toThrow(
      'cursor',
    );
    await expect(
      sqlStateRows(database, 'sqlite', prefix, `${prefix}invalid:${'a'.repeat(64)}`, 1, 'uuidDigest'),
    ).rejects.toThrow('cursor');
  });
  it('initializes once and rejects stale writers without changing saved state', async () => {
    const { backend } = fixture();
    expect(await backend.read()).toBeNull();
    expect(await backend.compareAndSwap(null, { revision: 'first', state: { counter: 1 } })).toBe(true);
    expect(await backend.compareAndSwap(null, { revision: 'second', state: { counter: 2 } })).toBe(false);
    expect(await backend.compareAndSwap('stale', { revision: 'second', state: { counter: 2 } })).toBe(false);
    expect(await backend.read()).toEqual({ revision: 'first', state: { counter: 1 } });
    expect(await backend.compareAndSwap('first', { revision: 'second', state: { counter: 2 } })).toBe(true);
    expect(await backend.read()).toEqual({ revision: 'second', state: { counter: 2 } });
  });
  it('preserves concurrent updates and isolates namespaces', async () => {
    const { backend, database } = fixture();
    const store = new OptimisticStateStore({
      backend,
      initial: () => ({ counter: 0 }),
      parse(value) {
        if (!value || typeof value !== 'object' || !('counter' in value) || typeof value.counter !== 'number')
          throw new Error('Invalid counter');
        return { counter: value.counter };
      },
    });
    await Promise.all(
      Array.from({ length: 8 }, () =>
        store.transact((state) => {
          state.counter++;
        }),
      ),
    );
    expect(await store.read()).toEqual({ counter: 8 });
    expect(
      await sqlStateBackend(database, 'sqlite', "other'; DROP TABLE SidedoorState;--").read(),
    ).toBeNull();
    expect(await store.read()).toEqual({ counter: 8 });
  });
  it('fails on corrupted stored JSON instead of resetting access state', async () => {
    const { backend, db } = fixture();
    db.prepare('INSERT INTO SidedoorState VALUES (?, ?, ?)').run('access', 'revision', '{corrupt');
    await expect(backend.read()).rejects.toThrow();
  });
});
