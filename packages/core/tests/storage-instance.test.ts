import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageInstanceControl } from '../src/storage/instance';
import { StorageWriteJournal, prepareStorageTombstone } from '../src/storage/write-journal';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function fixture(namespace = 'app') {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  const control = new StorageInstanceControl(executor, 'sqlite', namespace);
  const journal = new StorageWriteJournal(executor, 'sqlite', namespace);
  async function transaction<Result>(run: () => Promise<Result>) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await run();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  async function tombstone(instanceId: string) {
    await journal.forbidWrites(
      prepareStorageTombstone({
        namespace,
        subjectId: `instance:${instanceId}`,
        generation: 0,
        jobId: randomUUID(),
      }),
    );
  }
  return { database, executor, control, journal, transaction, tombstone };
}

describe('persistent storage instance identity', () => {
  it('requires explicit bootstrap and keeps the existing identity on initialization retries', async () => {
    const { database, control, transaction } = fixture();
    await expect(control.read()).rejects.toThrow('not initialized');
    const id = randomUUID();
    const initial = await transaction(() => control.initialize(id));
    expect(initial).toEqual({ instanceId: id, subjectId: `instance:${id}`, generation: 0 });
    const records = database.prepare('SELECT * FROM SidedoorState ORDER BY id').all();
    expect(await transaction(() => control.initialize(randomUUID()))).toEqual(initial);
    expect(database.prepare('SELECT * FROM SidedoorState ORDER BY id').all()).toEqual(records);
  });
  it('requires a tombstoned old instance and preserves its erasure evidence after rotation', async () => {
    const { control, journal, transaction, tombstone } = fixture();
    const first = randomUUID();
    const second = randomUUID();
    await transaction(() => control.initialize(first));
    await expect(transaction(() => control.rotate(first, second))).rejects.toThrow('tombstoned');
    await transaction(async () => {
      await tombstone(first);
      await control.rotate(first, second);
    });
    expect((await control.read()).instanceId).toBe(second);
    expect(await journal.tombstone(`instance:${first}`)).not.toBeNull();
    await expect(transaction(() => control.rotate(first, randomUUID()))).rejects.toThrow('changed');
    await transaction(() => tombstone(second));
    await expect(transaction(() => control.rotate(second, first))).rejects.toThrow('erased');
    expect((await control.read()).instanceId).toBe(second);
  });
  it('rolls back rotation and allocation with a failed application reset', async () => {
    const { control, journal, transaction, tombstone } = fixture();
    const first = randomUUID();
    const second = randomUUID();
    await transaction(() => control.initialize(first));
    await expect(
      transaction(async () => {
        await tombstone(first);
        await control.rotate(first, second);
        throw new Error('Application reset failed');
      }),
    ).rejects.toThrow('Application reset failed');
    expect((await control.read()).instanceId).toBe(first);
    expect(await journal.tombstone(`instance:${first}`)).toBeNull();
    await transaction(async () => {
      await tombstone(first);
      await control.rotate(first, second);
    });
    expect((await control.read()).instanceId).toBe(second);
  });
  it('does not reuse an allocated identity when control was lost without a tombstone', async () => {
    const { database, control, transaction } = fixture();
    const allocated = randomUUID();
    await transaction(() => control.initialize(allocated));
    database.exec("DELETE FROM SidedoorState WHERE json_extract(state, '$.kind') = 'storage_instance'");
    await expect(control.read()).rejects.toThrow('not initialized');
    await expect(transaction(() => control.initialize(allocated))).rejects.toThrow('allocated');
  });
  it('separates namespace control and rejects missing allocation evidence', async () => {
    const { database, executor, control, transaction } = fixture();
    const id = randomUUID();
    await transaction(() => control.initialize(id));
    const other = new StorageInstanceControl(executor, 'sqlite', 'other');
    await expect(other.read()).rejects.toThrow('not initialized');
    expect((await transaction(() => other.initialize(id))).instanceId).toBe(id);
    database.exec(
      "DELETE FROM SidedoorState WHERE json_extract(state, '$.kind') = 'storage_instance_allocation' AND json_extract(state, '$.namespace') = 'app'",
    );
    await expect(control.read()).rejects.toThrow('allocation is missing');
    expect((await other.read()).instanceId).toBe(id);
  });
});
