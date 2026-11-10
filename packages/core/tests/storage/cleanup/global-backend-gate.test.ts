import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, it } from 'vitest';
import { CleanupExecutionJournal } from '../../../src/storage/cleanup/cleanup-execution';
import { StorageCleanupJournal } from '../../../src/storage/cleanup/cleanup-journal';
import { prepareStorageCleanup } from '../../../src/storage/cleanup/cleanup-state';
import {
  prepareStorageBackend,
  StorageBackendRegistry,
} from '../../../src/storage/registry/backend-registry';
import { storageBackendBinding } from '../../../src/storage/registry/references';

it('prevents two namespaces from cleaning the same physical backend concurrently', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
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
  try {
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
    const descriptor = { kind: 'object' as const, location, binding: storageBackendBinding(location) };
    const firstBackend = prepareStorageBackend('first', descriptor);
    const secondBackend = prepareStorageBackend('second', descriptor);
    const firstJob = prepareStorageCleanup({ namespace: 'first', subjectId: 'learner:first', generation: 1 });
    const secondJob = prepareStorageCleanup({
      namespace: 'second',
      subjectId: 'learner:second',
      generation: 1,
    });
    const first = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: firstJob.id,
      backendBinding: firstBackend.binding,
    };
    const second = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: secondJob.id,
      backendBinding: secondBackend.binding,
    };
    const firstExecutions = new CleanupExecutionJournal(executor, 'sqlite', 'first');
    const secondExecutions = new CleanupExecutionJournal(executor, 'sqlite', 'second');
    await transaction(async () => {
      for (const [namespace, backend, job] of [
        ['first', firstBackend, firstJob],
        ['second', secondBackend, secondJob],
      ] as const) {
        await new StorageBackendRegistry(executor, 'sqlite', namespace).register(backend);
        const cleanup = new StorageCleanupJournal(executor, 'sqlite', namespace);
        await cleanup.createJob(job);
        await cleanup.registerCollectors(job.id, job.epoch, [
          {
            id: 'inventory',
            kind: 'inventory',
            backendIds: [backend.id],
            scope: 'learner/',
            match: 'prefix',
          },
        ]);
      }
    });
    const oldNamespace = createHash('sha256').update('legacy-namespace').digest('hex');
    const legacyId = `sd-ceg:1:${oldNamespace}:${first.backendBinding}`;
    database
      .prepare('INSERT INTO SidedoorState (id, revision, state) VALUES (?, ?, ?)')
      .run(legacyId, randomUUID(), JSON.stringify({ executionId: randomUUID(), settled: true }));
    await expect(transaction(() => firstExecutions.begin(first))).rejects.toThrow('Legacy cleanup gate');
    expect(database.prepare('SELECT id FROM SidedoorState WHERE id = ?').get(legacyId)).toBeDefined();
    database.prepare('DELETE FROM SidedoorState WHERE id = ?').run(legacyId);
    await transaction(() => firstExecutions.begin(first));
    const stored = database
      .prepare('SELECT state FROM SidedoorState WHERE id = ?')
      .get(`sd-ceg:2:${first.backendBinding}`);
    expect(JSON.stringify(stored)).not.toContain('first');
    await expect(transaction(() => secondExecutions.begin(second))).rejects.toThrow('unresolved');
    await transaction(() => firstExecutions.markUnconfirmed(first));
    await expect(transaction(() => secondExecutions.begin(second))).rejects.toThrow('unresolved');
    await transaction(() =>
      firstExecutions.resolveUnconfirmed(first, {
        id: randomUUID(),
        kind: 'remote-operations-settled',
      }),
    );
    await transaction(() => secondExecutions.begin(second));
    expect(await firstExecutions.hasConfirmedCompletion(firstJob.id, first.backendBinding)).toBe(false);
    await transaction(() => secondExecutions.settle(second));
    expect(await firstExecutions.hasConfirmedCompletion(firstJob.id, first.backendBinding)).toBe(true);
    await expect(transaction(() => firstExecutions.markUnconfirmed(first))).rejects.toThrow('settled');
  } finally {
    database.close();
  }
});
