import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
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
    database,
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

async function prepareLater(item: Awaited<ReturnType<typeof fixture>>, subjectId: string, retention = true) {
  const later = prepareStorageCleanup({
    namespace: 'test',
    subjectId,
    generation: 1,
    ...(retention ? { retentionPolicy: 'job-id-snapshots-v1' as const } : {}),
  });
  await item.transaction(async (tx) => {
    const journal = new StorageCleanupJournal(tx, 'sqlite', 'test');
    await journal.createJob(later);
    await journal.registerCollectors(later.id, later.epoch, [
      {
        id: 'inventory',
        kind: 'inventory',
        backendIds: [item.backend.id],
        scope: item.worksheet.target.key,
        match: 'key',
      },
    ]);
    await journal.recordManifestPage(later.id, later.epoch, { id: 'reference', entries: [{}] });
    await journal.resolveManifest(later.id, later.epoch, 'reference', {
      resolver: 'fixture',
      entries: [{ index: 0, kind: 'storage', targets: [item.worksheet.target] }],
    });
  });
  return later;
}

async function runLater(
  item: Awaited<ReturnType<typeof fixture>>,
  jobId: string,
  remove: (key: string) => Promise<void>,
) {
  return runStorageCleanup({
    namespace: 'test',
    dialect: 'sqlite',
    jobId,
    transaction: item.transaction,
    executor: (tx) => tx,
    ports: [
      {
        backendId: item.backend.id,
        binding: item.backend.binding,
        collect: async () => ({ targets: [], next: null }),
        delete: remove,
      },
    ],
  });
}

it('does not delete when the durable delegated binding is damaged', async () => {
  const item = await fixture();
  try {
    item.database
      .prepare("UPDATE SidedoorState SET state = json_set(state, '$.digest', ?) WHERE id LIKE 'sd-cda:1:%'")
      .run('0'.repeat(64));
    await expect(item.run((key) => item.local.delete(key))).rejects.toThrow('binding mismatch');
    expect(await item.local.has(item.worksheet.target.key)).toBe(true);
    expect(await item.local.has(item.other.target.key)).toBe(true);
  } finally {
    await item.close();
  }
});

it.each(['resolver', 'target', 'collector'] as const)(
  'does not delete when the delegated resolution %s is altered',
  async (field) => {
    const item = await fixture();
    try {
      if (field === 'target') {
        item.database
          .prepare(
            "UPDATE SidedoorState SET state = json_insert(state, '$.resolution.entries[0].targets[#]', json(?)) WHERE id LIKE 'sd-m:1:%'",
          )
          .run(JSON.stringify(item.other.target));
      } else {
        const path =
          field === 'resolver' ? '$.resolution.resolver' : '$.resolution.entries[0].collectorIds[0]';
        item.database
          .prepare("UPDATE SidedoorState SET state = json_set(state, ?, ?) WHERE id LIKE 'sd-m:1:%'")
          .run(path, 'altered');
      }
      await expect(item.run((key) => item.local.delete(key))).rejects.toThrow(
        'Delegated target proof does not match',
      );
      expect(await item.local.has(item.worksheet.target.key)).toBe(true);
      expect(await item.local.has(item.other.target.key)).toBe(true);
    } finally {
      await item.close();
    }
  },
);

it('does not let another cleanup job use the delegated retirement', async () => {
  const item = await fixture();
  try {
    const otherJob = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'class:unrelated',
      generation: 1,
    });
    await item.transaction(async (tx) => {
      const journal = new StorageCleanupJournal(tx, 'sqlite', 'test');
      await journal.createJob(otherJob);
      await journal.registerCollectors(otherJob.id, otherJob.epoch, [
        {
          id: 'inventory',
          kind: 'inventory',
          backendIds: [item.backend.id],
          scope: item.worksheet.target.key,
          match: 'key',
        },
      ]);
    });
    await expect(
      runStorageCleanup({
        namespace: 'test',
        dialect: 'sqlite',
        jobId: otherJob.id,
        transaction: item.transaction,
        executor: (tx) => tx,
        ports: [
          {
            backendId: item.backend.id,
            binding: item.backend.binding,
            collect: async () => ({ targets: [item.worksheet.target], next: null }),
            delete: (key) => item.local.delete(key),
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await item.local.has(item.worksheet.target.key)).toBe(true);
  } finally {
    await item.close();
  }
});

it('allows later cleanups to verify a target deleted by a completed delegated cleanup', async () => {
  const item = await fixture();
  try {
    const laterJobs = [
      await prepareLater(item, 'class:later'),
      await prepareLater(item, 'class:last', false),
    ];
    await item.run((key) => item.local.delete(key));
    expect((await item.cleanup.get(item.job.id)).phase).toBe('complete');
    for (const later of laterJobs) {
      await runLater(item, later.id, (key) => item.local.delete(key));
      expect((await item.cleanup.get(later.id)).phase).toBe('complete');
    }
    expect(await item.local.has(item.other.target.key)).toBe(true);
  } finally {
    await item.close();
  }
});

it.each(['manifest', 'binding', 'retirement', 'fence'] as const)(
  'refuses a later cleanup when completed delegated %s evidence is damaged',
  async (damage) => {
    const item = await fixture();
    try {
      const later = await prepareLater(item, 'class:later');
      await item.run((key) => item.local.delete(key));
      if (damage === 'manifest')
        item.database
          .prepare(
            "UPDATE SidedoorState SET state = json_set(state, '$.resolution.resolver', 'changed') WHERE id LIKE 'sd-m:1:%' AND json_extract(state, '$.jobId') = ?",
          )
          .run(item.job.id);
      if (damage === 'binding')
        item.database
          .prepare(
            "UPDATE SidedoorState SET state = json_set(state, '$.digest', ?) WHERE id LIKE 'sd-cda:1:%'",
          )
          .run('0'.repeat(64));
      if (damage === 'retirement')
        item.database.prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-retired:1:%'").run();
      if (damage === 'fence')
        item.database
          .prepare(
            "UPDATE SidedoorState SET state = json_set(state, '$.retirement', ?) WHERE id LIKE 'sd-tf:1:%'",
          )
          .run('0'.repeat(64));
      const remove = vi.fn(async (key: string) => item.local.delete(key));
      await expect(runLater(item, later.id, remove)).rejects.toThrow();
      expect(remove).not.toHaveBeenCalled();
      expect(await item.local.has(item.other.target.key)).toBe(true);
    } finally {
      await item.close();
    }
  },
);

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
