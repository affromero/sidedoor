import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { sqlStateBackend } from '../src/storage/sql';
import { OptimisticStateStore } from '../src/storage/optimistic';

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
