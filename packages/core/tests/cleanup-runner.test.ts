import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CleanupExecutionJournal,
  prepareStorageBackend,
  prepareStorageCleanup,
  runStorageCleanup,
  StorageBackendRegistry,
  StorageCleanupJournal,
  storageBackendBinding,
  type StorageCleanupBackendPort,
} from '../src/storage';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
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
  async function transaction<Result>(run: (value: typeof executor) => Promise<Result>) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await run(executor);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  const location = {
    kind: 'object' as const,
    endpoint: 'https://storage.example',
    bucket: 'private',
  };
  const backend = prepareStorageBackend('app', {
    kind: 'object',
    location,
    binding: storageBackendBinding(location),
  });
  const job = prepareStorageCleanup({
    namespace: 'app',
    subjectId: 'episode:one',
    generation: 1,
  });
  await transaction(async (tx) => {
    await new StorageBackendRegistry(tx, 'sqlite', 'app').register(backend);
    const journal = new StorageCleanupJournal(tx, 'sqlite', 'app');
    await journal.createJob(job);
    await journal.registerCollectors(job.id, job.epoch, [
      {
        id: 'references',
        kind: 'references',
        backendIds: [backend.id],
        scope: job.subjectId,
      },
      {
        id: 'inventory',
        kind: 'inventory',
        backendIds: [backend.id],
        scope: 'episodes/one/',
        match: 'prefix',
      },
    ]);
  });
  const target = {
    backendId: backend.id,
    binding: backend.binding,
    key: 'episodes/one/audio.mp3',
  };
  return { database, executor, transaction, backend, job, target };
}

describe('storage cleanup runner', () => {
  it('drains, deletes, verifies, and completes an admitted cleanup', async () => {
    const item = await fixture();
    const deleted: string[] = [];
    const port: StorageCleanupBackendPort = {
      backendId: item.backend.id,
      binding: item.backend.binding,
      collect: async (collector) => ({
        targets: collector.verification === 0 ? [item.target] : [],
        next: null,
      }),
      delete: async (key) => {
        deleted.push(key);
      },
    };
    await runStorageCleanup({
      namespace: 'app',
      dialect: 'sqlite',
      jobId: item.job.id,
      transaction: item.transaction,
      executor: (tx) => tx,
      ports: [port],
    });
    expect(deleted).toEqual(['episodes/one/audio.mp3']);
    expect(await new StorageCleanupJournal(item.executor, 'sqlite', 'app').get(item.job.id)).toMatchObject({
      phase: 'complete',
      pending: 0,
      deleted: 1,
      verification: 1,
    });
  });

  it('leaves backend ownership unresolved after a failed delete', async () => {
    const item = await fixture();
    const executorId = randomUUID();
    const failure = new Error('delete response was lost');
    const port: StorageCleanupBackendPort = {
      backendId: item.backend.id,
      binding: item.backend.binding,
      collect: async () => ({ targets: [item.target], next: null }),
      delete: vi.fn().mockRejectedValue(failure),
    };
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: item.job.id,
        executorId,
        transaction: item.transaction,
        executor: (tx) => tx,
        ports: [port],
      }),
    ).rejects.toBe(failure);
    const replacement = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: item.job.id,
      backendBinding: item.backend.binding,
    };
    await expect(
      item.transaction((tx) => new CleanupExecutionJournal(tx, 'sqlite', 'app').begin(replacement)),
    ).rejects.toThrow('unresolved');
    const unresolved = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
      item.backend.binding,
    );
    expect(unresolved).toMatchObject({
      executorId,
      jobId: item.job.id,
      backendBinding: item.backend.binding,
      status: 'unconfirmed',
    });
  });
});
