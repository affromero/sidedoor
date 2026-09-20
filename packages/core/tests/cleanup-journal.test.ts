import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageCleanupJournal } from '../src/storage/cleanup-journal';
import { CleanupExecutionJournal } from '../src/storage/cleanup-execution';
import type { StorageManifestInput } from '../src/storage/cleanup-manifests';
import {
  prepareStorageCleanup,
  type StorageCleanupJob,
  type StorageCleanupCollector,
} from '../src/storage/cleanup-state';
import { prepareStorageBackend, StorageBackendRegistry } from '../src/storage/backend-registry';
import { StorageWriteJournal, prepareStorageWrite } from '../src/storage/write-journal';
import { storageBackendBinding } from '../src/storage/references';
import {
  JobOutbox,
  JobSnapshot,
  JobRetentionCleanup,
  JobExecutionJournal,
  prepareJob,
} from '../src/runtime/outbox';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function fixture(retention = false) {
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
  const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
  const descriptor = { kind: 'object' as const, location, binding: storageBackendBinding(location) };
  const backend = prepareStorageBackend('app', descriptor);
  const historical = prepareStorageBackend('app', { ...descriptor, publicUrl: 'https://old.example/media' });
  const registry = new StorageBackendRegistry(executor, 'sqlite', 'app');
  await transaction(async () => {
    await registry.register(backend);
    await registry.register(historical);
  });
  const journal = new StorageCleanupJournal(executor, 'sqlite', 'app');
  const writes = new StorageWriteJournal(executor, 'sqlite', 'app');
  const prepared = prepareStorageCleanup({
    namespace: 'app',
    subjectId: 'learner',
    generation: 2,
    ...(retention ? { retentionPolicy: 'job-id-snapshots-v1' as const } : {}),
  });
  const collectors: StorageCleanupCollector[] = [
    { id: 'references', kind: 'references', scope: 'learner', backendIds: [backend.id, historical.id] },
    {
      id: 'inventory',
      kind: 'inventory',
      scope: 'recordings/learner/',
      backendIds: [backend.id, historical.id],
    },
  ];
  const target = { backendId: backend.id, binding: backend.binding, key: 'recordings/learner/owned.wav' };
  const page = (
    job: StorageCleanupJob,
    collectorId: string,
    targets = [target],
    next: string | null = null,
    after: string | null = null,
  ) =>
    transaction(() =>
      journal.recordCollectorPage({ jobId: job.id, epoch: job.epoch, collectorId, targets, next, after }),
    );
  async function collecting() {
    await transaction(() => journal.createJob(prepared));
    await transaction(() => journal.registerCollectors(prepared.id, 0, collectors));
    await page(prepared, 'references');
    const job = await transaction(() => journal.transition(prepared.id, 0));
    return transaction(() => journal.recordDrainedIntents(job.id, job.epoch, null));
  }
  async function deleting() {
    let job = await collecting();
    job = await page(job, 'inventory');
    job = await transaction(() => journal.transition(job.id, job.epoch));
    return transaction(() => journal.transition(job.id, job.epoch));
  }
  return {
    database,
    executor,
    journal,
    writes,
    prepared,
    collectors,
    target,
    backend,
    historical,
    transaction,
    page,
    collecting,
    deleting,
  };
}

describe('durable storage cleanup', () => {
  it('rejects stale executor deletion receipts and completion after ownership changes', async () => {
    const item = await fixture();
    const job = await item.deleting();
    const executions = new CleanupExecutionJournal(item.executor, 'sqlite', 'app');
    const original = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: job.id,
      backendBinding: item.backend.binding,
    };
    await item.transaction(() => executions.begin(original));
    const ticket = (await item.journal.pendingTargets(job.id, job.epoch)).tickets[0]!;
    await item.transaction(() => executions.markUnconfirmed(original));
    await item.transaction(() =>
      executions.resolveUnconfirmed(original, {
        id: randomUUID(),
        kind: 'remote-operations-settled',
      }),
    );
    const replacement = { ...original, executionId: randomUUID(), executorId: randomUUID() };
    await item.transaction(() => executions.begin(replacement));
    await expect(item.transaction(() => executions.acknowledgeTarget(original, ticket))).rejects.toThrow(
      'no longer owns',
    );
    await expect(
      item.transaction(() =>
        executions.acknowledgeTarget(
          {
            ...replacement,
            jobId: randomUUID(),
          },
          ticket,
        ),
      ),
    ).rejects.toThrow('does not own this deletion ticket');
    expect(await item.journal.get(job.id)).toMatchObject({ pending: 1 });
    await item.transaction(() => executions.acknowledgeTarget(replacement, ticket));
    const verifying = await item.transaction(() => item.journal.beginVerification(job.id, job.epoch));
    await item.page(verifying, 'inventory', []);
    await expect(
      item.transaction(() => executions.transition(job.id, verifying.epoch, [original])),
    ).rejects.toThrow('no longer owns');
    expect(await item.journal.get(job.id)).toMatchObject({ phase: 'verifying' });
    await item.transaction(() => executions.transition(job.id, verifying.epoch, [replacement]));
    expect(await item.journal.get(job.id)).toMatchObject({ phase: 'complete' });
  });

  it('retains backend ownership across uncertain cleanup and rejects stale executors after resolution', async () => {
    const item = await fixture();
    const executions = new CleanupExecutionJournal(item.executor, 'sqlite', 'app');
    await item.transaction(async () => {
      await item.journal.createJob(item.prepared);
      await item.journal.registerCollectors(item.prepared.id, 0, item.collectors);
    });
    const binding = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: item.prepared.id,
      backendBinding: item.backend.binding,
    };
    await item.transaction(() => executions.begin(binding));
    const replacement = { ...binding, executionId: randomUUID(), executorId: randomUUID() };
    await expect(item.transaction(() => executions.begin(replacement))).rejects.toThrow('unresolved');
    await item.transaction(() => executions.markUnconfirmed(binding));
    await expect(executions.assertOwned(binding)).rejects.toThrow('no longer owns');
    await expect(item.transaction(() => executions.begin(replacement))).rejects.toThrow('unresolved');
    const evidence = { id: randomUUID(), kind: 'remote-operations-settled' as const };
    await item.transaction(() => executions.resolveUnconfirmed(binding, evidence));
    await item.transaction(() => executions.begin(replacement));
    await expect(executions.assertOwned(binding)).rejects.toThrow('no longer owns');
    await expect(item.transaction(() => executions.begin(binding))).rejects.toThrow('no longer owns');
    await executions.assertOwned(replacement);
    expect(await executions.read(binding)).toMatchObject({ status: 'settled', resolution: evidence });
  });

  it('does not unlock a replacement executor when replaying a completed settlement', async () => {
    const item = await fixture();
    const executions = new CleanupExecutionJournal(item.executor, 'sqlite', 'app');
    await item.transaction(async () => {
      await item.journal.createJob(item.prepared);
      await item.journal.registerCollectors(item.prepared.id, 0, item.collectors);
    });
    const binding = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: item.prepared.id,
      backendBinding: item.backend.binding,
    };
    await item.transaction(() => executions.begin(binding));
    await item.transaction(() => executions.settle(binding));
    const replacement = { ...binding, executionId: randomUUID(), executorId: randomUUID() };
    await item.transaction(() => executions.begin(replacement));
    await item.transaction(() => executions.settle(binding));
    await executions.assertOwned(replacement);
    expect(await executions.read(binding)).toMatchObject({ status: 'settled' });
  });

  it('distinguishes an absent cleanup job from malformed persisted state', async () => {
    const { journal, prepared, transaction, database } = await fixture();
    expect(await journal.find(prepared.id)).toBeNull();
    await transaction(() => journal.createJob(prepared));
    expect(await journal.find(prepared.id)).toEqual(prepared);
    database
      .prepare(
        "UPDATE SidedoorState SET state = '{}' WHERE json_extract(state, '$.kind') = 'storage_cleanup'",
      )
      .run();
    await expect(journal.find(prepared.id)).rejects.toThrow();
  });

  it('preserves job snapshots until execution cleanup is confirmed and fences new work after deletion', async () => {
    const { executor, prepared, transaction, collecting } = await fixture(true);
    const outbox = new JobOutbox(executor, 'sqlite', 'app');
    const snapshots = new JobSnapshot(executor, 'sqlite', 'app');
    const executions = new JobExecutionJournal(executor, 'sqlite', 'app');
    const parent = await transaction(() =>
      outbox.enqueue(
        prepareJob({
          namespace: 'app',
          handler: 'audio',
          version: 1,
          payload: { episode: 'private-episode' },
          scopes: [{ subjectId: 'learner', generation: 2 }],
          delivery: { attempts: 2, priority: 0, availableAt: 0 },
        }),
      ),
    );
    const execution = {
      id: randomUUID(),
      parentId: parent.job.id,
      fingerprint: parent.fingerprint,
      executorId: randomUUID(),
    };
    await transaction(async () => {
      await executions.begin(execution);
      await snapshots.createForJob({ id: parent.job.id, fingerprint: parent.fingerprint });
      await snapshots.append(parent.job.id, parent.fingerprint, 0, ['private recovery inputs']);
      await snapshots.seal(parent.job.id, parent.fingerprint);
    });
    await collecting();
    const retention = new JobRetentionCleanup(executor, 'sqlite', 'app');
    await transaction(() => retention.step(prepared.id));
    await expect(transaction(() => retention.step(prepared.id))).rejects.toThrow('cleanup is unresolved');
    expect((await snapshots.read(parent.job.id, parent.fingerprint, 0)).items).toEqual([
      'private recovery inputs',
    ]);
    await transaction(() => executions.settle(execution));
    await expect(transaction(() => executions.begin({ ...execution, id: randomUUID() }))).rejects.toThrow(
      'being erased',
    );
    expect(await transaction(() => retention.step(prepared.id))).toEqual({ complete: true });
    expect(await outbox.receipt(parent.job.id)).toMatchObject({ status: 'erased' });
    expect((await executions.read(execution)).status).toBe('settled');
    await expect(snapshots.read(parent.job.id, parent.fingerprint, 0)).rejects.toThrow('being erased');
  });

  it('requires resumable payload and snapshot erasure before final cleanup completion', async () => {
    const { database, executor, journal, prepared, transaction, page, collecting } = await fixture(true);
    const outbox = new JobOutbox(executor, 'sqlite', 'app');
    const snapshots = new JobSnapshot(executor, 'sqlite', 'app');
    const records = [];
    for (let index = 0; index < 12; index++) {
      records.push(
        await transaction(() =>
          outbox.enqueue(
            prepareJob({
              namespace: 'app',
              handler: 'notifications',
              version: 1,
              payload: { text: `sensitive-lesson-${index}` },
              scopes: [{ subjectId: 'learner', generation: 2 }],
              delivery: { attempts: 3, priority: 0, availableAt: 0 },
            }),
          ),
        ),
      );
    }
    const first = records[0]!;
    await transaction(async () => {
      await snapshots.createForJob({ id: first.job.id, fingerprint: first.fingerprint });
      for (let index = 0; index < 12; index++)
        await snapshots.append(first.job.id, first.fingerprint, index, [`sensitive-device-${index}`]);
      await snapshots.seal(first.job.id, first.fingerprint);
    });
    // Simulate jobs created before the scope index existed.
    database.exec("DELETE FROM SidedoorState WHERE id GLOB 'sd-jsc:1:*'");
    const runner = new JobRetentionCleanup(executor, 'sqlite', 'app');
    await transaction(() => journal.createJob(prepared));
    await expect(transaction(() => runner.step(prepared.id))).rejects.toThrow('after writer drain');
    let job = await collecting();
    job = await page(job, 'inventory');
    job = await transaction(() => journal.transition(job.id, job.epoch));
    job = await transaction(() => journal.transition(job.id, job.epoch));
    for (const ticket of (await journal.pendingTargets(job.id, job.epoch)).tickets)
      await transaction(() => journal.acknowledgeTarget(ticket));
    job = await transaction(() => journal.beginVerification(job.id, job.epoch));
    job = await page(job, 'inventory', []);
    const previousEpoch = job.epoch;
    job = await transaction(() => journal.transition(job.id, job.epoch));
    expect(job).toMatchObject({ phase: 'verifying', epoch: previousEpoch + 1 });
    await expect(transaction(() => journal.transition(job.id, previousEpoch))).rejects.toThrow();
    await expect(
      transaction(async () => {
        await runner.step(job.id);
        throw new Error('Retention checkpoint failed');
      }),
    ).rejects.toThrow('Retention checkpoint failed');
    expect((await outbox.listForScope('learner', 2)).jobs).toHaveLength(10);
    let complete = false;
    let steps = 0;
    while (!complete && steps++ < 10) {
      job = await transaction(() =>
        new StorageCleanupJournal(executor, 'sqlite', 'app').transition(job.id, job.epoch),
      );
      complete = job.phase === 'complete';
    }
    expect(complete).toBe(true);
    expect(steps).toBeGreaterThan(1);
    for (const record of records)
      expect(await outbox.receipt(record.job.id)).toMatchObject({ status: 'erased' });
    expect(JSON.stringify(database.prepare('SELECT state FROM SidedoorState').all())).not.toContain(
      'sensitive-',
    );
    expect(job.phase).toBe('complete');
    expect(await transaction(() => runner.step(job.id))).toEqual({ complete: true });
  });
  it('lists jobs in bounded UUID pages and projects manifest status without exposing raw references', async () => {
    const { journal, prepared, transaction } = await fixture();
    const expected = Array.from({ length: 101 }, (_, index) =>
      prepareStorageCleanup({ namespace: 'app', subjectId: `profile-${index}`, generation: 1 }),
    );
    await transaction(async () => {
      for (const job of expected) await journal.createJob(job);
    });
    const first = await journal.listJobs();
    expect(first.jobs).toHaveLength(100);
    expect(first.cursor).not.toBeNull();
    const last = await journal.listJobs(first.cursor);
    expect(last.jobs).toHaveLength(1);
    expect(last.cursor).toBeNull();
    expect(new Set([...first.jobs, ...last.jobs].map((job) => job.id))).toEqual(
      new Set(expected.map((job) => job.id)),
    );
    await expect(journal.listJobs('invalid')).rejects.toThrow();
    await transaction(() => journal.createJob(prepared));
    expect(await journal.manifestStatus(prepared.id, 'guard')).toBeNull();
    await transaction(() =>
      journal.recordManifestPage(prepared.id, 0, { id: 'guard', entries: ['sensitive raw reference'] }),
    );
    expect(await journal.manifestStatus(prepared.id, 'guard')).toEqual({ resolved: false });
    await transaction(() =>
      journal.resolveManifest(prepared.id, 0, 'guard', {
        resolver: 'test',
        entries: [{ index: 0, kind: 'non_storage', reason: 'fixture text' }],
      }),
    );
    expect(await journal.manifestStatus(prepared.id, 'guard')).toEqual({ resolved: true });
  });
  it('resolves orphan upload prefixes through registered inventories without inventing exact files', async () => {
    const { journal, prepared, collectors, transaction, target } = await fixture();
    await transaction(() => journal.createJob(prepared));
    await transaction(() => journal.registerCollectors(prepared.id, 0, collectors));
    await transaction(() =>
      journal.recordManifestPage(prepared.id, 0, {
        id: 'prefix',
        entries: [{ prefix: 'recordings/learner/' }],
      }),
    );
    await expect(
      transaction(() =>
        journal.resolveManifest(prepared.id, 0, 'prefix', {
          resolver: 'app-v1',
          entries: [{ index: 0, kind: 'storage', targets: [], collectorIds: ['references'] }],
        }),
      ),
    ).rejects.toThrow('verification inventory collectors');
    await expect(
      transaction(() =>
        journal.resolveManifest(prepared.id, 0, 'prefix', {
          resolver: 'app-v1',
          entries: Array.from({ length: 11 }, (_, index) => ({
            index,
            kind: 'storage' as const,
            targets: Array.from({ length: 100 }, () => target),
          })),
        }),
      ),
    ).rejects.toThrow('target and collector limit');
    await transaction(() =>
      journal.resolveManifest(prepared.id, 0, 'prefix', {
        resolver: 'app-v1',
        entries: [{ index: 0, kind: 'storage', targets: [], collectorIds: ['inventory'] }],
      }),
    );
    expect(await journal.get(prepared.id)).toMatchObject({ pending: 0, unresolvedManifests: 0 });
    expect((await journal.listManifests(prepared.id)).pages[0]?.resolution?.entries).toEqual([
      { index: 0, kind: 'storage', targets: [], collectorIds: ['inventory'] },
    ]);
    expect((await transaction(() => journal.transition(prepared.id, 0))).phase).toBe('waiting');
  });
  it('preserves raw manifests and blocks cleanup until every entry has durable resolution', async () => {
    const { journal, prepared, collectors, target, transaction } = await fixture();
    await transaction(() => journal.createJob(prepared));
    await transaction(() => journal.registerCollectors(prepared.id, 0, collectors));
    const input: StorageManifestInput = {
      id: 'profile-avatar',
      entries: [{ field: 'image', value: 'https://old.example/owned.wav' }, { value: '/avatars/toucan.png' }],
    };
    await transaction(() => journal.recordManifestPage(prepared.id, 0, input));
    await transaction(() =>
      journal.recordManifestPage(prepared.id, 0, {
        ...input,
        entries: [
          { value: 'https://old.example/owned.wav', field: 'image' },
          { value: '/avatars/toucan.png' },
        ],
      }),
    );
    expect(await journal.get(prepared.id)).toMatchObject({ manifestCount: 1, unresolvedManifests: 1 });
    await expect(transaction(() => journal.transition(prepared.id, 0))).rejects.toThrow(
      'unresolved reference manifests',
    );
    const resolution = {
      resolver: 'app-v1',
      entries: [
        { index: 0, kind: 'storage' as const, targets: [target] },
        { index: 1, kind: 'non_storage' as const, reason: 'Exact shipped avatar path' },
      ],
    };
    await transaction(() => journal.resolveManifest(prepared.id, 0, input.id, resolution));
    await transaction(() => journal.resolveManifest(prepared.id, 0, input.id, resolution));
    expect(await journal.get(prepared.id)).toMatchObject({
      manifestCount: 1,
      unresolvedManifests: 0,
      pending: 1,
    });
    const stored = await journal.listManifests(prepared.id);
    expect(stored.cursor).toBeNull();
    expect(stored.pages).toEqual([expect.objectContaining({ ...input, resolution })]);
    await expect(
      transaction(() => journal.recordManifestPage(prepared.id, 0, { ...input, entries: ['changed'] })),
    ).rejects.toThrow('payload is immutable');
    await expect(
      transaction(() =>
        journal.resolveManifest(prepared.id, 0, input.id, { ...resolution, resolver: 'changed' }),
      ),
    ).rejects.toThrow('resolution is immutable');
    const waiting = await transaction(() => journal.transition(prepared.id, 0));
    expect(waiting.phase).toBe('waiting');
    await expect(
      transaction(() =>
        journal.recordManifestPage(prepared.id, waiting.epoch, { id: 'late', entries: ['lost'] }),
      ),
    ).rejects.toThrow('manifests are frozen');
  });

  it('rolls back target additions when resolution is incomplete or outside verified inventories', async () => {
    const { journal, prepared, collectors, target, transaction } = await fixture();
    await transaction(() => journal.createJob(prepared));
    await transaction(() => journal.registerCollectors(prepared.id, 0, collectors));
    await transaction(() =>
      journal.recordManifestPage(prepared.id, 0, { id: 'raw', entries: ['first', 'second'] }),
    );
    await expect(
      transaction(() =>
        journal.resolveManifest(prepared.id, 0, 'raw', {
          resolver: 'app-v1',
          entries: [{ index: 0, kind: 'storage', targets: [target] }],
        }),
      ),
    ).rejects.toThrow('every entry exactly once');
    await expect(
      transaction(() =>
        journal.resolveManifest(prepared.id, 0, 'raw', {
          resolver: 'app-v1',
          entries: [
            { index: 0, kind: 'storage', targets: [target] },
            { index: 1, kind: 'storage', targets: [{ ...target, key: 'outside/file.wav' }] },
          ],
        }),
      ),
    ).rejects.toThrow('no verification inventory');
    expect(await journal.get(prepared.id)).toMatchObject({ pending: 0, unresolvedManifests: 1 });
    expect((await journal.listManifests(prepared.id)).pages[0]?.resolution).toBeNull();
  });

  it('bounds manifest entry count and bytes and retains all pages across keyset scans', async () => {
    const { journal, prepared, transaction } = await fixture();
    await transaction(() => journal.createJob(prepared));
    await expect(
      transaction(() =>
        journal.recordManifestPage(prepared.id, 0, { id: 'oversized', entries: ['x'.repeat(1024 * 1024)] }),
      ),
    ).rejects.toThrow('byte limit');
    await expect(
      transaction(() =>
        journal.recordManifestPage(prepared.id, 0, {
          id: 'too-many',
          entries: Array.from({ length: 101 }, () => null),
        }),
      ),
    ).rejects.toThrow();
    await transaction(async () => {
      for (let index = 0; index < 101; index++)
        await journal.recordManifestPage(prepared.id, 0, {
          id: `page-${index}`,
          entries: [{ value: `unknown-${index}` }],
        });
    });
    const first = await journal.listManifests(prepared.id);
    expect(first.pages).toHaveLength(1);
    expect(first.cursor).not.toBeNull();
    const ids = new Set(first.pages.map((page) => page.id));
    let cursor = first.cursor;
    while (cursor !== null) {
      const next = await journal.listManifests(prepared.id, cursor);
      expect(next.pages).toHaveLength(1);
      for (const page of next.pages) ids.add(page.id);
      cursor = next.cursor;
    }
    expect(ids.size).toBe(101);
    expect(await journal.get(prepared.id)).toMatchObject({ manifestCount: 101, unresolvedManifests: 101 });
  });
  it('covers root-level files through exact-key inventory without authorizing similarly named files', async () => {
    const { journal, prepared, backend, target, transaction, page } = await fixture();
    await transaction(() => journal.createJob(prepared));
    await transaction(() =>
      journal.registerCollectors(prepared.id, 0, [
        { id: 'avatar', kind: 'inventory', scope: 'avatar.png', match: 'key', backendIds: [backend.id] },
        { id: 'references', kind: 'references', scope: 'learner', backendIds: [backend.id] },
      ]),
    );
    await page(prepared, 'references', [{ ...target, key: 'avatar.png' }]);
    let job = await transaction(() => journal.transition(prepared.id, 0));
    job = await transaction(() => journal.recordDrainedIntents(job.id, job.epoch, null));
    await expect(page(job, 'avatar', [{ ...target, key: 'avatar.png.backup' }])).rejects.toThrow(
      'outside its inventory prefix',
    );
    await page(job, 'avatar', [{ ...target, key: 'avatar.png' }]);
    expect(await transaction(() => journal.transition(job.id, job.epoch))).toMatchObject({
      phase: 'ready',
      pending: 1,
    });
  });

  it('keeps hundreds of episode scopes in bounded records and freezes them before discovery', async () => {
    const { journal, prepared, backend, transaction } = await fixture();
    await transaction(() => journal.createJob(prepared));
    const scopes: StorageCleanupCollector[] = Array.from({ length: 305 }, (_, index) => ({
      id: `episode-${index}`,
      kind: 'inventory',
      scope: `episodes/${index}/`,
      backendIds: [backend.id],
    }));
    for (let offset = 0; offset < scopes.length; offset += 100) {
      await transaction(() => journal.registerCollectors(prepared.id, 0, scopes.slice(offset, offset + 100)));
    }
    await transaction(() => journal.registerCollectors(prepared.id, 0, scopes.slice(0, 100)));
    const saved = await journal.get(prepared.id);
    expect(saved).toMatchObject({ collectorCount: 305, inventoryCount: 305, remainingCollectors: 305 });
    expect(JSON.stringify(saved).length).toBeLessThan(1024);
    const found: string[] = [];
    let after: string | null = null;
    do {
      const page = await journal.listCollectors(prepared.id, after);
      expect(page.collectors.length).toBeLessThanOrEqual(100);
      found.push(...page.collectors.map((collector) => collector.scope));
      after = page.cursor;
    } while (after);
    expect(new Set(found)).toEqual(new Set(scopes.map((collector) => collector.scope)));
    const job = await transaction(() => journal.transition(prepared.id, 0));
    await expect(transaction(() => journal.registerCollectors(job.id, job.epoch, scopes))).rejects.toThrow(
      'scopes are frozen',
    );
  });

  it('rejects ambiguous prefixes and keys belonging to neighbouring learners', async () => {
    const { journal, prepared, collectors, target, transaction, page } = await fixture();
    await transaction(() => journal.createJob(prepared));
    await expect(
      transaction(() =>
        journal.registerCollectors(prepared.id, 0, [{ ...collectors[1]!, scope: 'recordings/learner' }]),
      ),
    ).rejects.toThrow('exact directory prefix');
    await transaction(() => journal.registerCollectors(prepared.id, 0, collectors));
    await expect(
      page(prepared, 'references', [{ ...target, key: 'recordings/learner-neighbour/private.wav' }]),
    ).rejects.toThrow('no verification inventory');
    expect((await journal.get(prepared.id)).pending).toBe(0);
  });

  it('restarts a non-resumable iterator from the beginning without duplicating manifest targets', async () => {
    const { journal, target, transaction, page, collecting } = await fixture();
    const job = await collecting();
    await page(job, 'inventory', [target], 'local-page-1');
    await transaction(() => journal.restartCollector(job.id, job.epoch, 'inventory'));
    await page(job, 'inventory', [target], 'local-page-1');
    await page(job, 'inventory', [], null, 'local-page-1');
    expect(await transaction(() => journal.transition(job.id, job.epoch))).toMatchObject({
      phase: 'ready',
      pending: 1,
    });
    await expect(
      transaction(() => journal.restartCollector(job.id, job.epoch + 1, 'inventory')),
    ).rejects.toThrow('cannot restart');
  });

  it('rolls back the tombstone and saved targets when the application deletion transaction fails', async () => {
    const { journal, writes, prepared, collectors, target, transaction } = await fixture();
    await expect(
      transaction(async () => {
        await journal.createJob(prepared);
        await journal.registerCollectors(prepared.id, 0, collectors);
        await journal.recordCollectorPage({
          jobId: prepared.id,
          epoch: 0,
          collectorId: 'references',
          after: null,
          next: null,
          targets: [target],
        });
        throw new Error('Application cascade failed');
      }),
    ).rejects.toThrow('Application cascade failed');
    expect(await writes.tombstone('learner')).toBeNull();
    await expect(journal.get(prepared.id)).rejects.toThrow('is missing');
    await transaction(() => journal.createJob(prepared));
    expect((await journal.get(prepared.id)).pending).toBe(0);
  });

  it('waits for observed writer completion and permanently rejects new writes', async () => {
    const { writes, journal, prepared, collectors, target, transaction } = await fixture();
    const intent = prepareStorageWrite({ namespace: 'app', subjectId: 'learner', generation: 2, target });
    await transaction(() => writes.begin(intent, 2));
    await transaction(() => journal.createJob(prepared));
    await transaction(() => journal.registerCollectors(prepared.id, 0, collectors));
    const job = await transaction(() => journal.transition(prepared.id, 0));
    await expect(transaction(() => journal.recordDrainedIntents(job.id, job.epoch, null))).rejects.toThrow(
      'waiting for write completion',
    );
    await transaction(() => writes.finish(intent, { kind: 'uncertain' }));
    await expect(transaction(() => journal.recordDrainedIntents(job.id, job.epoch, null))).rejects.toThrow(
      'waiting for write completion',
    );
    await transaction(() =>
      writes.resolveUncertain(intent, { kind: 'stopped_writer', id: 'operator-evidence' }),
    );
    expect(await transaction(() => journal.recordDrainedIntents(job.id, job.epoch, null))).toMatchObject({
      phase: 'collecting',
      pending: 1,
    });
    await expect(
      transaction(() =>
        writes.begin(
          prepareStorageWrite({ namespace: 'app', subjectId: 'learner', generation: 2, target }),
          2,
        ),
      ),
    ).rejects.toThrow('being erased');
    expect((await writes.list('learner')).intents[0]?.status).toBe('settled');
  });

  it('resumes partial inventory after restart without accepting stale pages or incomplete discovery', async () => {
    const { executor, target, transaction, page, collecting } = await fixture();
    const job = await collecting();
    await page(job, 'inventory', [target], 'page2');
    const restarted = new StorageCleanupJournal(executor, 'sqlite', 'app');
    expect(
      (await restarted.listCollectors(job.id)).collectors.find((item) => item.id === 'inventory'),
    ).toMatchObject({
      cursor: 'page2',
      complete: false,
    });
    await expect(transaction(() => restarted.transition(job.id, job.epoch))).rejects.toThrow(
      'discovery is incomplete',
    );
    await expect(page(job, 'inventory')).rejects.toThrow('position changed');
    await page(job, 'inventory', [], null, 'page2');
    expect(await transaction(() => restarted.transition(job.id, job.epoch))).toMatchObject({
      phase: 'ready',
      pending: 1,
    });
  });

  it('preserves historical descriptor provenance while deduplicating a physical object', async () => {
    const { journal, target, historical, page, transaction, collecting } = await fixture();
    let job = await collecting();
    job = await page(job, 'inventory', [target, { ...target, backendId: historical.id }]);
    job = await transaction(() => journal.transition(job.id, job.epoch));
    job = await transaction(() => journal.transition(job.id, job.epoch));
    const { tickets } = await journal.pendingTargets(job.id, job.epoch);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.target.backendIds).toEqual([target.backendId, historical.id]);
    expect(job.pending).toBe(1);
  });

  it('keeps failed deletions pending and requires a fresh verification before completion', async () => {
    const { journal, transaction, page, deleting } = await fixture();
    let job = await deleting();
    const { tickets } = await journal.pendingTargets(job.id, job.epoch);
    await expect(transaction(() => journal.beginVerification(job.id, job.epoch))).rejects.toThrow(
      'pending targets',
    );
    expect((await journal.pendingTargets(job.id, job.epoch)).tickets).toEqual(tickets);
    await transaction(() => journal.acknowledgeTarget(tickets[0]!));
    await expect(transaction(() => journal.acknowledgeTarget(tickets[0]!))).rejects.toThrow(
      'ticket is stale',
    );
    job = await transaction(() => journal.beginVerification(job.id, job.epoch));
    await expect(transaction(() => journal.transition(job.id, job.epoch))).rejects.toThrow(
      'verification is incomplete',
    );
    job = await page(job, 'inventory', []);
    job = await transaction(() => journal.transition(job.id, job.epoch));
    expect(job).toMatchObject({ phase: 'complete', pending: 0, deleted: 1, verification: 1 });
    await expect(transaction(() => journal.acknowledgeTarget(tickets[0]!))).rejects.toThrow('phase changed');
  });

  it('reopens rediscovered objects and rejects acknowledgements from the previous deletion pass', async () => {
    const { journal, transaction, page, deleting } = await fixture();
    let job = await deleting();
    const old = (await journal.pendingTargets(job.id, job.epoch)).tickets[0]!;
    await transaction(() => journal.acknowledgeTarget(old));
    job = await transaction(() => journal.beginVerification(job.id, job.epoch));
    job = await page(job, 'inventory');
    job = await transaction(() => journal.transition(job.id, job.epoch));
    expect(job).toMatchObject({ phase: 'deleting', pending: 1, deleted: 0 });
    await expect(transaction(() => journal.acknowledgeTarget(old))).rejects.toThrow('phase changed');
    const current = (await journal.pendingTargets(job.id, job.epoch)).tickets[0]!;
    expect(current.revision).not.toBe(old.revision);
    await transaction(() => journal.acknowledgeTarget(current));
    job = await transaction(() => journal.beginVerification(job.id, job.epoch));
    await page(job, 'inventory', []);
    expect(await transaction(() => journal.transition(job.id, job.epoch))).toMatchObject({
      phase: 'complete',
      verification: 2,
    });
  });

  it('bounds manifest reads and resumes across acknowledged rows', async () => {
    const { journal, target, page, transaction, collecting } = await fixture();
    let job = await collecting();
    job = await page(
      job,
      'inventory',
      Array.from({ length: 205 }, (_, index) => ({ ...target, key: `recordings/learner/${index}.wav` })),
    );
    job = await transaction(() => journal.transition(job.id, job.epoch));
    job = await transaction(() => journal.transition(job.id, job.epoch));
    const first = await journal.pendingTargets(job.id, job.epoch);
    expect(first.tickets).toHaveLength(100);
    await transaction(async () => {
      for (const ticket of first.tickets) await journal.acknowledgeTarget(ticket);
    });
    expect((await journal.pendingTargets(job.id, job.epoch)).tickets).toHaveLength(0);
    const second = await journal.pendingTargets(job.id, job.epoch, first.cursor);
    const third = await journal.pendingTargets(job.id, job.epoch, second.cursor);
    expect(second.tickets).toHaveLength(100);
    expect(third.tickets).toHaveLength(6);
    expect(third.cursor).toBeNull();
    await expect(journal.pendingTargets(job.id, job.epoch, `different:${first.cursor}`)).rejects.toThrow(
      'another namespace',
    );
  });
});
