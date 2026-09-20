import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { cleanupStorageProbe } from '../../../src/storage/cleanup/backends/probe-cleanup';
import { StorageCleanupJournal } from '../../../src/storage/cleanup/cleanup-journal';
import { prepareStorageCleanup } from '../../../src/storage/cleanup/cleanup-state';
import {
  StorageBackendRegistry,
  prepareStorageBackend,
} from '../../../src/storage/registry/backend-registry';
import { StorageWriteJournal, prepareStorageWrite } from '../../../src/storage/execution/write-journal';
import { storageBackendBinding } from '../../../src/storage/registry/references';
import { CleanupExecutionJournal } from '../../../src/storage/cleanup/cleanup-execution';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture(outcome: 'unreferenced' | 'uncertain' | 'active' = 'unreferenced') {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec('CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)');
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return db.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  async function transaction<Result>(run: (tx: typeof executor) => Promise<Result>) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await run(executor);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'probe' };
  const backend = prepareStorageBackend('app', {
    kind: 'object',
    location,
    binding: storageBackendBinding(location),
  });
  const target = { backendId: backend.id, binding: backend.binding, key: `probes/${randomUUID()}.txt` };
  const job = prepareStorageCleanup({
    namespace: 'app',
    subjectId: `storage-probe:${randomUUID()}`,
    generation: 0,
  });
  const writes = new StorageWriteJournal(executor, 'sqlite', 'app');
  const cleanup = new StorageCleanupJournal(executor, 'sqlite', 'app');
  const execution = {
    executionId: randomUUID(),
    executorId: randomUUID(),
    jobId: job.id,
    backendBinding: backend.binding,
  };
  const intent = prepareStorageWrite({ namespace: 'app', subjectId: job.subjectId, generation: 0, target });
  await transaction(async () => {
    await new StorageBackendRegistry(executor, 'sqlite', 'app').register(backend);
    await writes.begin(intent, 0);
    await cleanup.createJob(job);
    await cleanup.registerCollectors(job.id, 0, [
      {
        id: 'probe',
        kind: 'inventory',
        backendIds: [backend.id],
        scope: target.key,
        match: 'key',
      },
    ]);
    if (outcome !== 'active') await writes.finish(intent, { kind: outcome });
    await new CleanupExecutionJournal(executor, 'sqlite', 'app').begin(execution);
  });
  const objects = new Set([target.key]);
  const options = {
    namespace: 'app',
    dialect: 'sqlite' as const,
    jobId: job.id,
    subjectId: job.subjectId,
    target,
    execution,
    transaction,
    executor: (tx: typeof executor) => tx,
    has: async (key: string) => objects.has(key),
    delete: async (key: string) => {
      objects.delete(key);
    },
  };
  return { options, objects, cleanup, writes, job };
}

it('deletes an admitted probe and completes a fresh verification inventory', async () => {
  const item = await fixture();
  await cleanupStorageProbe(item.options);
  expect(item.objects.size).toBe(0);
  expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'complete', verification: 1 });
  expect(await item.writes.tombstone('profile:owner')).toBeNull();
  await cleanupStorageProbe(item.options);
});

it('retains an uncertain upload even when its object is currently absent', async () => {
  const item = await fixture('uncertain');
  item.objects.clear();
  await expect(cleanupStorageProbe(item.options)).rejects.toThrow('waiting for write completion');
  expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'waiting' });
});

it('rejects an unknown executor when recovering an already completed probe', async () => {
  const item = await fixture();
  await cleanupStorageProbe(item.options);
  await expect(
    cleanupStorageProbe({
      ...item.options,
      execution: {
        ...item.options.execution,
        executionId: randomUUID(),
      },
    }),
  ).rejects.toThrow('confirmed execution identity');
  await expect(
    cleanupStorageProbe({
      ...item.options,
      execution: {
        ...item.options.execution,
        executorId: randomUUID(),
      },
    }),
  ).rejects.toThrow('identity does not match');
});

it('retains the captured executor when the caller mutates its identity during inventory', async () => {
  const item = await fixture();
  const original = { ...item.options.execution };
  await cleanupStorageProbe({
    ...item.options,
    has: async (key) => {
      item.options.execution.executorId = randomUUID();
      return item.objects.has(key);
    },
  });
  expect(item.objects.size).toBe(0);
  await cleanupStorageProbe({ ...item.options, execution: original });
});

it('resumes deletion after the backend rejects cleanup', async () => {
  const item = await fixture();
  await expect(
    cleanupStorageProbe({
      ...item.options,
      delete: async () => {
        throw new Error('Storage unavailable');
      },
    }),
  ).rejects.toThrow('Storage unavailable');
  expect(item.objects.size).toBe(1);
  expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'deleting', pending: 1 });
  await cleanupStorageProbe(item.options);
  expect(item.objects.size).toBe(0);
  expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'complete' });
});

it('refuses an unrelated destination before any deletion', async () => {
  const item = await fixture();
  await expect(
    cleanupStorageProbe({
      ...item.options,
      target: {
        ...item.options.target,
        key: 'recordings/unrelated.wav',
      },
    }),
  ).rejects.toThrow('exact captured target');
  expect(item.objects.size).toBe(1);
});

it('retains recovery state when deletion happened but its response was lost', async () => {
  const item = await fixture();
  await expect(
    cleanupStorageProbe({
      ...item.options,
      delete: async (key) => {
        item.objects.delete(key);
        throw new Error('Deletion response lost');
      },
    }),
  ).rejects.toThrow('Deletion response lost');
  expect(item.objects.size).toBe(0);
  expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'deleting', pending: 1 });
  await cleanupStorageProbe(item.options);
  expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'complete', pending: 0 });
});

it('does not report completion when the destination keeps reappearing', async () => {
  const item = await fixture();
  await expect(
    cleanupStorageProbe({
      ...item.options,
      has: async (key) => {
        item.objects.add(key);
        return true;
      },
    }),
  ).rejects.toThrow('keeps reappearing');
  expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'verifying' });
});

it('waits for an active upload without deleting its object', async () => {
  const item = await fixture('active');
  await expect(cleanupStorageProbe(item.options)).rejects.toThrow('waiting for write completion');
  expect(item.objects.size).toBe(1);
});

it('deletes an object that reappears once during verification', async () => {
  const item = await fixture();
  let recreated = false;
  await cleanupStorageProbe({
    ...item.options,
    has: async (key) => {
      const job = await item.cleanup.get(item.job.id);
      if (job.phase === 'verifying' && !recreated) {
        recreated = true;
        item.objects.add(key);
      }
      return item.objects.has(key);
    },
  });
  expect(item.objects.size).toBe(0);
  expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'complete', verification: 2 });
});

it.each(['acknowledgement', 'completion'] as const)(
  'recovers an accepted %s transaction after its response is lost',
  async (boundary) => {
    const item = await fixture();
    let lost = false;
    await expect(
      cleanupStorageProbe({
        ...item.options,
        transaction: async (run) => {
          const result = await item.options.transaction(run);
          const job = await item.cleanup.get(item.job.id);
          if (
            !lost &&
            (boundary === 'completion'
              ? job.phase === 'complete'
              : job.phase === 'deleting' && job.pending === 0)
          ) {
            lost = true;
            throw new Error('Committed response lost');
          }
          return result;
        },
      }),
    ).rejects.toThrow('Committed response lost');
    expect(item.objects.size).toBe(0);
    await cleanupStorageProbe(item.options);
    expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'complete', pending: 0 });
  },
);
