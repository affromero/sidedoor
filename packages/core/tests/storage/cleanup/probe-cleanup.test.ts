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
  return { options, objects, cleanup, writes, job, executor };
}

async function recoverSettledIo(item: Awaited<ReturnType<typeof fixture>>) {
  const previous = item.options.execution;
  const next = { ...previous, executionId: randomUUID(), executorId: randomUUID() };
  await item.options.transaction(async (tx) => {
    const executions = new CleanupExecutionJournal(tx, 'sqlite', 'app');
    await executions.resolveUnconfirmed(previous, { id: randomUUID(), kind: 'remote-operations-settled' });
    await executions.begin(next);
  });
  return { ...item.options, execution: next };
}

it('deletes an admitted probe and completes a fresh verification inventory', async () => {
  const item = await fixture();
  await cleanupStorageProbe(item.options);
  expect(item.objects.size).toBe(0);
  expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'complete', verification: 1 });
  expect(await item.writes.tombstone('profile:owner')).toBeNull();
  await cleanupStorageProbe(item.options);
});

it('records deletion uncertainty before dispatching the backend operation', async () => {
  const item = await fixture();
  await cleanupStorageProbe({
    ...item.options,
    delete: async (key) => {
      const current = await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(
        item.options.target.binding,
      );
      expect(current?.status).toBe('unconfirmed');
      item.objects.delete(key);
    },
  });
});

it('cannot replace an unresolved delete with an unrelated inventory operation', async () => {
  const item = await fixture();
  const executions = new CleanupExecutionJournal(item.executor, 'sqlite', 'app');
  const revision = await item.options.transaction(() =>
    executions.beginUnconfirmedOperation(item.options.execution, 'delete'),
  );
  await expect(
    item.options.transaction(() => executions.beginUnconfirmedOperation(item.options.execution, 'read')),
  ).rejects.toThrow('no longer owns');
  await expect(
    item.options.transaction(() => executions.confirmObservedIo(item.options.execution, revision)),
  ).rejects.toThrow('operation does not match');
  expect((await executions.current(item.options.target.binding))?.status).toBe('unconfirmed');
});

it('requires settled-operation evidence before retrying a lost inventory response', async () => {
  const item = await fixture();
  await expect(
    cleanupStorageProbe({
      ...item.options,
      has: async () => {
        throw new Error('inventory response lost');
      },
    }),
  ).rejects.toThrow('inventory response lost');
  const executions = new CleanupExecutionJournal(item.executor, 'sqlite', 'app');
  expect((await executions.current(item.options.target.binding))?.status).toBe('unconfirmed');
  await expect(cleanupStorageProbe(item.options)).rejects.toThrow('no longer owns');
  await cleanupStorageProbe(await recoverSettledIo(item));
  expect((await item.cleanup.get(item.job.id)).phase).toBe('complete');
});

it('rejects an inventory result after execution ownership becomes uncertain', async () => {
  const item = await fixture();
  await expect(
    cleanupStorageProbe({
      ...item.options,
      has: async (key) => {
        await item.options.transaction((tx) =>
          new CleanupExecutionJournal(tx, 'sqlite', 'app').markUnconfirmed(item.options.execution),
        );
        return item.objects.has(key);
      },
    }),
  ).rejects.toThrow('unconfirmed operation changed');
  expect(item.objects.size).toBe(1);
  expect(
    (await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(item.options.target.binding))
      ?.status,
  ).toBe('unconfirmed');
});

it('does not acknowledge deletion after execution ownership becomes uncertain', async () => {
  const item = await fixture();
  await expect(
    cleanupStorageProbe({
      ...item.options,
      delete: async (key) => {
        item.objects.delete(key);
        await item.options.transaction((tx) =>
          new CleanupExecutionJournal(tx, 'sqlite', 'app').markUnconfirmed(item.options.execution),
        );
      },
    }),
  ).rejects.toThrow('unconfirmed operation changed');
  expect(await item.cleanup.get(item.job.id)).toMatchObject({ phase: 'deleting', pending: 1 });
  expect(
    (await new CleanupExecutionJournal(item.executor, 'sqlite', 'app').current(item.options.target.binding))
      ?.status,
  ).toBe('unconfirmed');
});

it('rejects an older completed-probe executor while its successor remains unconfirmed', async () => {
  const item = await fixture();
  await expect(
    cleanupStorageProbe({
      ...item.options,
      has: async () => {
        throw new Error('inventory response lost');
      },
    }),
  ).rejects.toThrow('inventory response lost');
  const successor = await recoverSettledIo(item);
  await cleanupStorageProbe(successor);
  await item.options.transaction((tx) =>
    new CleanupExecutionJournal(tx, 'sqlite', 'app').markUnconfirmed(successor.execution),
  );
  await expect(cleanupStorageProbe(item.options)).rejects.toThrow('confirmed execution');
});

it('does not accept a completed probe while an older execution remains uncertain', async () => {
  const item = await fixture();
  const executions = new CleanupExecutionJournal(item.executor, 'sqlite', 'app');
  const first = item.options.execution;
  const second = { ...first, executionId: randomUUID(), executorId: randomUUID() };
  await item.options.transaction(async () => {
    await executions.settle(first);
    await executions.begin(second);
    await executions.markUnconfirmed(first);
  });
  const successor = { ...item.options, execution: second };
  await expect(cleanupStorageProbe(successor)).rejects.toThrow('confirmed');
  await item.options.transaction(() =>
    executions.resolveUnconfirmed(first, {
      id: randomUUID(),
      kind: 'remote-operations-settled',
    }),
  );
  await expect(cleanupStorageProbe(successor)).resolves.toBeUndefined();
  expect((await item.cleanup.get(item.job.id)).phase).toBe('complete');
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

it('requires settled-operation evidence before resuming a rejected delete', async () => {
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
  await expect(cleanupStorageProbe(item.options)).rejects.toThrow('no longer owns');
  await cleanupStorageProbe(await recoverSettledIo(item));
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
  await expect(cleanupStorageProbe(item.options)).rejects.toThrow('no longer owns');
  await cleanupStorageProbe(await recoverSettledIo(item));
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
