import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, it } from 'vitest';
import { StorageCleanupAttribution } from '../../../src/storage/cleanup/cleanup-attribution';
import { CleanupExecutionJournal } from '../../../src/storage/cleanup/cleanup-execution';
import { StorageCleanupJournal } from '../../../src/storage/cleanup/cleanup-journal';
import { runStorageCleanup } from '../../../src/storage/cleanup/cleanup-runner';
import { prepareStorageCleanup } from '../../../src/storage/cleanup/cleanup-state';
import { LocalStorageCleanup } from '../../../src/storage/cleanup/backends/local-cleanup';
import { StorageWriteJournal, prepareStorageWrite } from '../../../src/storage/execution/write-journal';
import {
  StorageBackendRegistry,
  prepareStorageBackend,
} from '../../../src/storage/registry/backend-registry';
import { withFileLock } from '../../../src/storage/registry/lock';
import {
  StorageReferenceRegistry,
  prepareStorageReference,
} from '../../../src/storage/registry/reference-registry';

async function fixture() {
  const database = new DatabaseSync(':memory:');
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-delegated-cleanup-'));
  const root = join(directory, 'storage');
  await mkdir(root);
  await writeFile(join(root, 'worksheet.pdf'), 'worksheet');
  await writeFile(join(root, 'other.pdf'), 'other');
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  async function transaction<Result>(run: (tx: typeof executor) => Promise<Result>): Promise<Result> {
    database.exec('BEGIN');
    try {
      const result = await run(executor);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  const local = await LocalStorageCleanup.capture(root);
  const backend = prepareStorageBackend('test', {
    kind: 'local',
    identity: local.identity,
    referenceRoot: root,
  });
  const scope = { subjectId: 'course:fixture', generation: 1 };
  const prepare = (key: string) =>
    prepareStorageReference({
      namespace: 'test',
      operationId: randomUUID(),
      reference: `/storage/${key}`,
      localRoutePrefix: '/storage',
      target: { backendId: backend.id, binding: backend.binding, key },
      scopes: [scope],
    });
  const worksheet = prepare('worksheet.pdf');
  const other = prepare('other.pdf');
  const consumer = 'class:fixture:worksheet';
  const registry = new StorageReferenceRegistry(executor, 'sqlite', 'test');
  const journal = new StorageCleanupJournal(executor, 'sqlite', 'test');
  const job = prepareStorageCleanup({
    namespace: 'test',
    subjectId: 'class:fixture',
    generation: 1,
    retentionPolicy: 'job-id-snapshots-v1',
  });
  await transaction(async () => {
    await new StorageBackendRegistry(executor, 'sqlite', 'test').register(backend);
    await registry.replace({ consumer, previousReference: null, next: worksheet });
    await registry.replace({ consumer: 'class:other:worksheet', previousReference: null, next: other });
    await journal.createJob(job);
    await new StorageCleanupAttribution(executor, 'sqlite', 'test').admitDelegatedAsset({
      jobId: job.id,
      epoch: job.epoch,
      subjectId: job.subjectId,
      generation: job.generation,
      originalScope: scope,
      consumer,
      reference: worksheet.reference,
      operationId: randomUUID(),
      verifyOwnership: async () => true,
    });
  });
  async function run(deleteFile: (key: string) => Promise<void>, signal?: AbortSignal) {
    return withFileLock(join(directory, 'backend.lock'), () =>
      runStorageCleanup({
        namespace: 'test',
        dialect: 'sqlite',
        jobId: job.id,
        signal,
        transaction,
        executor: (tx) => tx,
        ports: [
          {
            backendId: backend.id,
            binding: backend.binding,
            collect: async (collector) => ({
              targets: (await local.has(collector.scope)) ? [worksheet.target] : [],
              next: null,
            }),
            delete: deleteFile,
          },
        ],
      }),
    );
  }
  async function close() {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
  return {
    backend,
    cleanup: journal,
    close,
    executor,
    job,
    local,
    other,
    registry,
    run,
    scope,
    transaction,
    worksheet,
  };
}

it('deletes only the delegated worksheet and retains its cleanup evidence and target fence', async () => {
  const item = await fixture();
  try {
    await item.run((key) => item.local.delete(key));
    expect((await item.cleanup.get(item.job.id)).phase).toBe('complete');
    expect(await item.local.has(item.worksheet.target.key)).toBe(false);
    expect(await item.local.has(item.other.target.key)).toBe(true);
    expect(
      await item.registry.resolve({ consumer: 'class:other:worksheet', reference: item.other.reference }),
    ).toMatchObject({ prepared: item.other });
    const pages = (await item.cleanup.listManifests(item.job.id)).pages;
    expect(JSON.stringify(pages)).toContain(item.worksheet.reference);
    const late = prepareStorageWrite({ namespace: 'test', ...item.scope, target: item.worksheet.target });
    await expect(
      item.transaction(() =>
        new StorageWriteJournal(item.executor, 'sqlite', 'test').begin(late, item.scope.generation),
      ),
    ).rejects.toThrow('target is retired');
  } finally {
    await item.close();
  }
});

it('keeps a lost deletion acknowledgment unresolved even when the file is gone', async () => {
  const item = await fixture();
  try {
    await expect(
      item.run(async (key) => {
        await item.local.delete(key);
        throw new Error('Deletion acknowledgment lost');
      }),
    ).rejects.toThrow('Deletion acknowledgment lost');
    expect(await item.local.has(item.worksheet.target.key)).toBe(false);
    expect((await item.cleanup.get(item.job.id)).phase).not.toBe('complete');
    expect(
      await new CleanupExecutionJournal(item.executor, 'sqlite', 'test').current(item.backend.binding),
    ).toMatchObject({ jobId: item.job.id, status: 'unconfirmed' });
    await expect(item.run((key) => item.local.delete(key))).rejects.toThrow('unresolved');
    expect(await item.local.has(item.other.target.key)).toBe(true);
  } finally {
    await item.close();
  }
});

it('leaves deletion unresolved if backend ownership is lost after dispatch', async () => {
  const item = await fixture();
  const controller = new AbortController();
  try {
    await expect(
      item.run(async (key) => {
        await item.local.delete(key);
        controller.abort(new Error('Backend ownership lost'));
      }, controller.signal),
    ).rejects.toThrow('Backend ownership lost');
    expect(await item.local.has(item.worksheet.target.key)).toBe(false);
    expect((await item.cleanup.get(item.job.id)).phase).not.toBe('complete');
    expect(
      await new CleanupExecutionJournal(item.executor, 'sqlite', 'test').current(item.backend.binding),
    ).toMatchObject({ jobId: item.job.id, status: 'unconfirmed' });
    await expect(item.run((key) => item.local.delete(key))).rejects.toThrow('unresolved');
    expect(await item.local.has(item.other.target.key)).toBe(true);
  } finally {
    await item.close();
  }
});
