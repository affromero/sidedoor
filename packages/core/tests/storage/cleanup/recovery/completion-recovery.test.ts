import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { expect, it } from 'vitest';
import { CleanupExecutionJournal } from '../../../../src/storage/cleanup/cleanup-execution';
import { StorageCleanupJournal } from '../../../../src/storage/cleanup/cleanup-journal';
import { runStorageCleanup } from '../../../../src/storage/cleanup/cleanup-runner';
import { prepareStorageCleanup } from '../../../../src/storage/cleanup/cleanup-state';
import {
  prepareStorageBackend,
  StorageBackendRegistry,
} from '../../../../src/storage/registry/backend-registry';
import { storageBackendBinding } from '../../../../src/storage/registry/references';

it('does not accept completion while an older execution remains uncertain', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  async function transaction<Result>(run: (tx: typeof executor) => Promise<Result>) {
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
  try {
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
    const backend = prepareStorageBackend('app', {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
    });
    const job = prepareStorageCleanup({ namespace: 'app', subjectId: 'learner', generation: 1 });
    const first = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: job.id,
      backendBinding: backend.binding,
    };
    const later = { ...first, executionId: randomUUID(), executorId: randomUUID() };
    const second = { ...first, executionId: randomUUID(), executorId: randomUUID() };
    await transaction(async (tx) => {
      const cleanup = new StorageCleanupJournal(tx, 'sqlite', 'app');
      const executions = new CleanupExecutionJournal(tx, 'sqlite', 'app');
      await new StorageBackendRegistry(tx, 'sqlite', 'app').register(backend);
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
      await executions.begin(first);
      await executions.settle(first);
      await executions.begin(later);
      await executions.settle(later);
      await executions.begin(second);
      await executions.markUnconfirmed(first);
      let current = await executions.transition(job.id, job.epoch, [second]);
      current = await cleanup.recordDrainedIntents(job.id, current.epoch, null);
      current = await cleanup.recordCollectorPage({
        jobId: job.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [],
      });
      current = await executions.transition(job.id, current.epoch, [second]);
      current = await executions.transition(job.id, current.epoch, [second]);
      current = await cleanup.beginVerification(job.id, current.epoch);
      current = await cleanup.recordCollectorPage({
        jobId: job.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [],
      });
      await expect(executions.transition(job.id, current.epoch, [second])).rejects.toThrow(
        'requires confirmed backend execution',
      );
      await executions.resolveUnconfirmed(first, { id: randomUUID(), kind: 'remote-operations-settled' });
      current = await cleanup.get(job.id);
      current = await cleanup.recordCollectorPage({
        jobId: job.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [],
      });
      await executions.transition(job.id, current.epoch, [second]);
      await executions.markUnconfirmed(later);
      await executions.settle(second);
    });
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: job.id,
        transaction,
        executor: (tx) => tx,
        ports: [
          {
            backendId: backend.id,
            binding: backend.binding,
            collect: async () => ({ targets: [], next: null }),
            delete: async () => {},
          },
        ],
      }),
    ).rejects.toThrow('requires confirmed backend execution');
    await transaction((tx) =>
      new CleanupExecutionJournal(tx, 'sqlite', 'app').resolveUnconfirmed(later, {
        id: randomUUID(),
        kind: 'remote-operations-settled',
      }),
    );
    const after = await new StorageCleanupJournal(executor, 'sqlite', 'app').get(job.id);
    expect(after.phase).toBe('verifying');
    expect(
      await new CleanupExecutionJournal(executor, 'sqlite', 'app').current(backend.binding),
    ).toMatchObject({ executionId: second.executionId, status: 'settled' });
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: job.id,
        transaction,
        executor: (tx) => tx,
        ports: [
          {
            backendId: backend.id,
            binding: backend.binding,
            collect: async () => ({ targets: [], next: null }),
            delete: async () => {},
          },
        ],
      }),
    ).resolves.toBeUndefined();
  } finally {
    database.close();
  }
});

it('does not report success if an older execution becomes uncertain after verification', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  async function transaction<Result>(run: (tx: typeof executor) => Promise<Result>) {
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
  try {
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
    const backend = prepareStorageBackend('app', {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
    });
    const job = prepareStorageCleanup({ namespace: 'app', subjectId: 'learner', generation: 1 });
    const previous = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: job.id,
      backendBinding: backend.binding,
    };
    await transaction(async (tx) => {
      const cleanup = new StorageCleanupJournal(tx, 'sqlite', 'app');
      const executions = new CleanupExecutionJournal(tx, 'sqlite', 'app');
      await new StorageBackendRegistry(tx, 'sqlite', 'app').register(backend);
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
      await executions.begin(previous);
      await executions.settle(previous);
    });
    let interrupted = false;
    await expect(
      runStorageCleanup({
        namespace: 'app',
        dialect: 'sqlite',
        jobId: job.id,
        transaction: async <Result>(run: (tx: typeof executor) => Promise<Result>) => {
          const result = await transaction(run);
          if (
            !interrupted &&
            (await new StorageCleanupJournal(executor, 'sqlite', 'app').get(job.id)).phase === 'complete'
          ) {
            interrupted = true;
            await transaction((tx) =>
              new CleanupExecutionJournal(tx, 'sqlite', 'app').markUnconfirmed(previous),
            );
          }
          return result;
        },
        executor: (tx: typeof executor) => tx,
        ports: [
          {
            backendId: backend.id,
            binding: backend.binding,
            collect: async () => ({ targets: [], next: null }),
            delete: async () => {},
          },
        ],
      }),
    ).rejects.toThrow('requires confirmed backend execution');
  } finally {
    database.close();
  }
});

it('waits for uncertain work from another job on the same backend', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  async function transaction<Result>(run: (tx: typeof executor) => Promise<Result>) {
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
  try {
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
    const backend = prepareStorageBackend('app', {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
    });
    const earlierJob = prepareStorageCleanup({ namespace: 'app', subjectId: 'earlier', generation: 1 });
    const laterJob = prepareStorageCleanup({ namespace: 'app', subjectId: 'later', generation: 1 });
    const first = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: earlierJob.id,
      backendBinding: backend.binding,
    };
    const second = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: laterJob.id,
      backendBinding: backend.binding,
    };
    const another = { ...first, executionId: randomUUID(), executorId: randomUUID() };
    const target = { backendId: backend.id, binding: backend.binding, key: 'later/asset.txt' };
    await transaction(async (tx) => {
      const cleanup = new StorageCleanupJournal(tx, 'sqlite', 'app');
      const executions = new CleanupExecutionJournal(tx, 'sqlite', 'app');
      await new StorageBackendRegistry(tx, 'sqlite', 'app').register(backend);
      for (const job of [earlierJob, laterJob]) {
        await cleanup.createJob(job);
        await cleanup.registerCollectors(job.id, job.epoch, [
          {
            id: 'inventory',
            kind: 'inventory',
            backendIds: [backend.id],
            scope: `${job.subjectId}/`,
            match: 'prefix',
          },
        ]);
      }
      await executions.begin(first);
      await executions.settle(first);
      await executions.begin(another);
      await executions.settle(another);
      await executions.begin(second);
      await executions.markUnconfirmed(first);
      let current = await executions.transition(laterJob.id, laterJob.epoch, [second]);
      current = await cleanup.recordDrainedIntents(laterJob.id, current.epoch, null);
      current = await cleanup.recordCollectorPage({
        jobId: laterJob.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [target],
      });
      current = await executions.transition(laterJob.id, current.epoch, [second]);
      current = await executions.transition(laterJob.id, current.epoch, [second]);
      const ticket = (await cleanup.pendingTargets(laterJob.id, current.epoch)).tickets[0];
      if (!ticket) throw new Error('Cleanup target is missing');
      await expect(executions.authorizeTarget(second, ticket)).rejects.toThrow('unconfirmed execution');
      await executions.resolveUnconfirmed(first, { id: randomUUID(), kind: 'remote-operations-settled' });
      await executions.authorizeTarget(second, ticket);
      await executions.acknowledgeTarget(second, ticket);
      current = await cleanup.beginVerification(laterJob.id, current.epoch);
      current = await cleanup.recordCollectorPage({
        jobId: laterJob.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [],
      });
      await executions.markUnconfirmed(another);
      await expect(executions.transition(laterJob.id, current.epoch, [second])).rejects.toThrow(
        'requires confirmed backend execution',
      );
      await executions.resolveUnconfirmed(another, { id: randomUUID(), kind: 'remote-operations-settled' });
      await expect(executions.transition(laterJob.id, current.epoch, [second])).rejects.toThrow(
        'phase changed',
      );
      current = await cleanup.get(laterJob.id);
      current = await cleanup.recordCollectorPage({
        jobId: laterJob.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [],
      });
      await executions.transition(laterJob.id, current.epoch, [second]);
      await executions.settle(second);
    });
    expect((await new StorageCleanupJournal(executor, 'sqlite', 'app').get(laterJob.id)).phase).toBe(
      'complete',
    );
  } finally {
    database.close();
  }
});

it('does not complete while another namespace has uncertain work on the same backend', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  async function transaction<Result>(run: (tx: typeof executor) => Promise<Result>) {
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
  try {
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
    const descriptor = { kind: 'object' as const, location, binding: storageBackendBinding(location) };
    const firstBackend = prepareStorageBackend('first', descriptor);
    const secondBackend = prepareStorageBackend('second', descriptor);
    const firstJob = prepareStorageCleanup({ namespace: 'first', subjectId: 'first-learner', generation: 1 });
    const secondJob = prepareStorageCleanup({
      namespace: 'second',
      subjectId: 'second-learner',
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
    await transaction(async (tx) => {
      const firstCleanup = new StorageCleanupJournal(tx, 'sqlite', 'first');
      const secondCleanup = new StorageCleanupJournal(tx, 'sqlite', 'second');
      const firstExecutions = new CleanupExecutionJournal(tx, 'sqlite', 'first');
      const secondExecutions = new CleanupExecutionJournal(tx, 'sqlite', 'second');
      await new StorageBackendRegistry(tx, 'sqlite', 'first').register(firstBackend);
      await new StorageBackendRegistry(tx, 'sqlite', 'second').register(secondBackend);
      for (const [cleanup, job, backend] of [
        [firstCleanup, firstJob, firstBackend],
        [secondCleanup, secondJob, secondBackend],
      ] as const) {
        await cleanup.createJob(job);
        await cleanup.registerCollectors(job.id, job.epoch, [
          {
            id: 'inventory',
            kind: 'inventory',
            backendIds: [backend.id],
            scope: `${job.subjectId}/`,
            match: 'prefix',
          },
        ]);
      }
      await firstExecutions.begin(first);
      await firstExecutions.settle(first);
      await secondExecutions.begin(second);
      await firstExecutions.markUnconfirmed(first);
      let current = await secondExecutions.transition(secondJob.id, secondJob.epoch, [second]);
      current = await secondCleanup.recordDrainedIntents(secondJob.id, current.epoch, null);
      current = await secondCleanup.recordCollectorPage({
        jobId: secondJob.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [],
      });
      current = await secondExecutions.transition(secondJob.id, current.epoch, [second]);
      current = await secondExecutions.transition(secondJob.id, current.epoch, [second]);
      current = await secondCleanup.beginVerification(secondJob.id, current.epoch);
      current = await secondCleanup.recordCollectorPage({
        jobId: secondJob.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [],
      });
      await expect(secondExecutions.transition(secondJob.id, current.epoch, [second])).rejects.toThrow(
        'requires confirmed backend execution',
      );
      await firstExecutions.resolveUnconfirmed(first, {
        id: randomUUID(),
        kind: 'remote-operations-settled',
      });
      await expect(secondExecutions.transition(secondJob.id, current.epoch, [second])).rejects.toThrow(
        'phase changed',
      );
      current = await secondCleanup.get(secondJob.id);
      current = await secondCleanup.recordCollectorPage({
        jobId: secondJob.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [],
      });
      await secondExecutions.transition(secondJob.id, current.epoch, [second]);
    });
  } finally {
    database.close();
  }
});
