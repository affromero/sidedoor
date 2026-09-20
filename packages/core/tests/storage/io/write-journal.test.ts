import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  StorageWriteJournal,
  prepareStorageWrite,
  prepareStorageTombstone,
} from '../../../src/storage/execution/write-journal';
import {
  prepareStorageBackend,
  StorageBackendRegistry,
} from '../../../src/storage/registry/backend-registry';
import { storageBackendBinding } from '../../../src/storage/registry/references';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function fixture() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    "CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE Learner (id TEXT PRIMARY KEY, reference TEXT); INSERT INTO Learner VALUES ('learner', NULL)",
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  const journal = new StorageWriteJournal(executor, 'sqlite', 'app');
  const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
  const backend = prepareStorageBackend('app', {
    kind: 'object',
    location,
    binding: storageBackendBinding(location),
  });
  const prepare = (subjectId = 'learner') =>
    prepareStorageWrite({
      namespace: 'app',
      subjectId,
      generation: 2,
      target: { backendId: backend.id, binding: backend.binding, key: 'recordings/owned.wav' },
    });
  async function transaction<Result>(run: () => Promise<Result>): Promise<Result> {
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
  await transaction(() => new StorageBackendRegistry(executor, 'sqlite', 'app').register(backend));
  return { database, journal, prepare, transaction, executor };
}

describe('durable storage write journal', () => {
  it('removes proven uncreated writes without scheduling deletion or permitting operation reuse', async () => {
    const { journal, prepare, transaction } = await fixture();
    const intent = prepare();
    expect(await transaction(() => journal.completion(intent))).toBeNull();
    await transaction(() => journal.begin(intent, 2));
    expect(await transaction(() => journal.finish(intent, { kind: 'not_created' }))).toBe('removed');
    expect((await journal.list('learner')).intents).toEqual([]);
    expect(await transaction(() => journal.completion(intent))).toBe('not_created');
    expect(await transaction(() => journal.begin(intent, 2))).toBe('already_completed');
    expect(await transaction(() => journal.finish(intent, { kind: 'not_created' }))).toBe('removed');
    await expect(
      transaction(() => journal.finish(intent, { kind: 'referenced', currentGeneration: 2 })),
    ).rejects.toThrow('conflicts');
  });

  it('does not relabel uncertain writes or committed references as never created', async () => {
    const { journal, prepare, transaction } = await fixture();
    const uncertain = prepare();
    await transaction(() => journal.begin(uncertain, 2));
    await transaction(() => journal.finish(uncertain, { kind: 'uncertain' }));
    await expect(transaction(() => journal.finish(uncertain, { kind: 'not_created' }))).rejects.toThrow(
      'conflicts',
    );
    const committed = prepare('another');
    await transaction(() => journal.begin(committed, 2));
    await transaction(() => journal.finish(committed, { kind: 'referenced', currentGeneration: 2 }));
    expect(await transaction(() => journal.completion(committed))).toBe('referenced');
    await expect(transaction(() => journal.finish(committed, { kind: 'not_created' }))).rejects.toThrow(
      'conflicts',
    );
  });
  it('rechecks completed writes against current scope eligibility without changing journal state', async () => {
    const { database, journal, prepare, transaction } = await fixture();
    const intent = prepare();
    await transaction(() => journal.begin(intent, 2));
    await transaction(() => journal.finish(intent, { kind: 'referenced', currentGeneration: 2 }));
    const snapshot = () => database.prepare('SELECT * FROM SidedoorState ORDER BY id').all();
    const completed = snapshot();
    await transaction(() => journal.assertWritable(intent, 2));
    await expect(transaction(() => journal.assertWritable(intent, 3))).rejects.toThrow('generation');
    expect(snapshot()).toEqual(completed);
    await transaction(() =>
      journal.forbidWrites(
        prepareStorageTombstone({
          namespace: 'app',
          subjectId: 'learner',
          generation: 2,
          jobId: randomUUID(),
        }),
      ),
    );
    const erased = snapshot();
    await expect(transaction(() => journal.assertWritable(intent, 2))).rejects.toThrow('erased');
    expect(snapshot()).toEqual(erased);
  });
  it('requires the registered physical backend and an exact key before a write can start', async () => {
    const { journal, prepare, transaction } = await fixture();
    const intent = prepare();
    await expect(
      transaction(() =>
        journal.begin({ ...intent, target: { ...intent.target, backendId: '0'.repeat(64) } }, 2),
      ),
    ).rejects.toThrow('descriptor is missing');
    await expect(
      transaction(() =>
        journal.begin({ ...intent, target: { ...intent.target, binding: 'f'.repeat(64) } }, 2),
      ),
    ).rejects.toThrow('does not match');
    expect(() =>
      prepareStorageWrite({
        namespace: 'app',
        subjectId: 'learner',
        generation: 2,
        target: { ...intent.target, key: '../outside' },
      }),
    ).toThrow();
    expect((await journal.list('learner')).intents).toEqual([]);
  });
  it('prepares stable operations and distinguishes an already-started write without changing its destination', async () => {
    const { journal, prepare, transaction } = await fixture();
    const intent = prepare();
    expect(await transaction(() => journal.begin(intent, 2))).toBe('created');
    expect(await transaction(() => journal.begin(intent, 2))).toBe('already_started');
    await expect(
      transaction(() => journal.begin({ ...intent, target: { ...intent.target, key: 'other' } }, 2)),
    ).rejects.toThrow('identity was already used');
    expect((await journal.list('learner')).intents).toEqual([intent]);
  });

  it('rolls back authority deletion and its tombstone together', async () => {
    const { database, journal, prepare, transaction } = await fixture();
    const marker = prepareStorageTombstone({
      namespace: 'app',
      subjectId: 'learner',
      generation: 2,
      jobId: randomUUID(),
    });
    await expect(
      transaction(async () => {
        await journal.forbidWrites(marker);
        database.prepare('DELETE FROM Learner WHERE id = ?').run('learner');
        throw new Error('Deletion interrupted');
      }),
    ).rejects.toThrow('Deletion interrupted');
    expect(await journal.tombstone('learner')).toBeNull();
    expect(database.prepare('SELECT id FROM Learner').all()).toEqual([{ id: 'learner' }]);
    await transaction(() => journal.begin(prepare(), 2));
  });

  it('retains in-flight and uncertain destinations after erasure and forbids future reuse of the subject ID', async () => {
    const { database, journal, prepare, transaction } = await fixture();
    const intent = prepare();
    await transaction(() => journal.begin(intent, 2));
    const marker = prepareStorageTombstone({
      namespace: 'app',
      subjectId: 'learner',
      generation: 2,
      jobId: randomUUID(),
    });
    await transaction(async () => {
      await journal.forbidWrites(marker);
      database.prepare('DELETE FROM Learner WHERE id = ?').run('learner');
    });
    expect((await journal.list('learner')).intents[0]?.status).toBe('active');
    await transaction(() => journal.finish(intent, { kind: 'uncertain' }));
    expect((await journal.list('learner')).intents[0]?.status).toBe('uncertain');
    await expect(
      transaction(() => journal.finish(intent, { kind: 'referenced', currentGeneration: 2 })),
    ).rejects.toThrow('conflicts');
    const resolution = { kind: 'observed_io_completion' as const, id: 'confirmed-operation-completion' };
    await transaction(() => journal.resolveUncertain(intent, resolution));
    await transaction(() => journal.resolveUncertain(intent, resolution));
    expect((await journal.list('learner')).intents[0]).toEqual({
      ...intent,
      status: 'settled',
      outcome: 'unreferenced',
      resolution,
    });
    await expect(transaction(() => journal.finish(intent, { kind: 'uncertain' }))).rejects.toThrow(
      'conflicts',
    );
    await expect(transaction(() => journal.begin({ ...prepare(), generation: 3 }, 3))).rejects.toThrow(
      'being erased',
    );
    expect(await journal.tombstone('learner')).toEqual(marker);
  });

  it('removes a write intent only with the successful reference commit', async () => {
    const { database, journal, prepare, transaction } = await fixture();
    const intent = prepare();
    await transaction(() => journal.begin(intent, 2));
    await expect(
      transaction(async () => {
        database.prepare('UPDATE Learner SET reference = ? WHERE id = ?').run(intent.target.key, 'learner');
        await journal.finish(intent, { kind: 'referenced', currentGeneration: 2 });
        throw new Error('Reference commit interrupted');
      }),
    ).rejects.toThrow('Reference commit interrupted');
    expect(database.prepare('SELECT reference FROM Learner').get()).toEqual({ reference: null });
    expect((await journal.list('learner')).intents).toEqual([intent]);
    await transaction(async () => {
      database.prepare('UPDATE Learner SET reference = ? WHERE id = ?').run(intent.target.key, 'learner');
      expect(await journal.finish(intent, { kind: 'referenced', currentGeneration: 2 })).toBe('removed');
    });
    expect((await journal.list('learner')).intents).toEqual([]);
    expect(database.prepare('SELECT reference FROM Learner').get()).toEqual({ reference: intent.target.key });
    expect(await transaction(() => journal.begin(intent, 2))).toBe('already_completed');
    expect(
      await transaction(() => journal.finish(intent, { kind: 'referenced', currentGeneration: 2 })),
    ).toBe('removed');
    await expect(transaction(() => journal.finish(intent, { kind: 'uncertain' }))).rejects.toThrow(
      'conflicts',
    );
    await expect(
      transaction(() =>
        journal.begin({ ...intent, target: { ...intent.target, key: 'replayed-target' } }, 2),
      ),
    ).rejects.toThrow('identity was already used');
  });

  it('keeps identical terminal outcomes idempotent and rejects conflicting callbacks', async () => {
    const { journal, prepare, transaction } = await fixture();
    const intent = prepare();
    await transaction(() => journal.begin(intent, 2));
    expect(await transaction(() => journal.finish(intent, { kind: 'unreferenced' }))).toBe('retained');
    expect(await transaction(() => journal.finish(intent, { kind: 'unreferenced' }))).toBe('retained');
    await expect(
      transaction(() => journal.finish(intent, { kind: 'referenced', currentGeneration: 2 })),
    ).rejects.toThrow('conflicts');
    await expect(
      transaction(() => journal.resolveUncertain(intent, { kind: 'stopped_writer', id: 'shutdown-record' })),
    ).rejects.toThrow('not awaiting');
    expect((await journal.list('learner')).intents[0]?.status).toBe('settled');
  });

  it('rejects stale generations and paginates within the exact namespace and subject', async () => {
    const { journal, prepare, transaction, executor } = await fixture();
    const first = prepare();
    await expect(transaction(() => journal.begin(first, 3))).rejects.toThrow('generation');
    for (const intent of [first, prepare(), prepare('other')])
      await transaction(() => journal.begin(intent, 2));
    const page = await journal.list('learner', { limit: 1 });
    expect(page.intents).toHaveLength(1);
    const next = await journal.list('learner', { limit: 1, after: page.cursor! });
    expect(next.intents).toHaveLength(1);
    expect(next.intents[0]?.operationId).not.toBe(page.intents[0]?.operationId);
    expect((await journal.list('learner', { after: next.cursor! })).intents).toEqual([]);
    expect((await new StorageWriteJournal(executor, 'sqlite', 'another').list('learner')).intents).toEqual(
      [],
    );
    await expect(journal.list('other', { after: page.cursor! })).rejects.toThrow('another subject');
    await expect(
      transaction(() => journal.finish(first, { kind: 'referenced', currentGeneration: 3 })),
    ).rejects.toThrow('generation');
    expect((await journal.list('learner')).intents).toHaveLength(2);
  });
});
