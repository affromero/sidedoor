import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareStorageBackend,
  prepareStorageCleanup,
  prepareStorageWrite,
  runStorageCleanup,
  StorageBackendRegistry,
  StorageCleanupJournal,
  StorageWriteJournal,
  CleanupExecutionJournal,
  storageBackendBinding,
} from '../../../../src/storage';
import { StorageTargetFence } from '../../../../src/storage/execution/target-fence';

describe('cleanup target retirement ownership', () => {
  it.each([
    'missing-tombstone',
    'wrong-tombstone',
    'missing-target',
    'pending-target',
    'wrong-target',
    'unconfirmed-execution',
    'foreign-predecessor',
    'incomplete-counters',
    'missing-retention',
    'missing-retention-proof',
    'changed-retention-proof',
    'incomplete-retention-proof',
    'no-retention-policy',
  ] as const)('checks completed predecessor when evidence is %s', async (damage) => {
    const database = new DatabaseSync(':memory:');
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
    try {
      const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
      const backend = prepareStorageBackend('app', {
        kind: 'object',
        location,
        binding: storageBackendBinding(location),
      });
      const previous = prepareStorageCleanup({
        namespace: 'app',
        subjectId: 'profile:previous',
        generation: 1,
        ...(damage === 'no-retention-policy' ? {} : { retentionPolicy: 'job-id-snapshots-v1' as const }),
      });
      const next = prepareStorageCleanup({
        namespace: 'app',
        subjectId: 'profile:next',
        generation: 1,
        retentionPolicy: 'job-id-snapshots-v1',
      });
      const target = { backendId: backend.id, binding: backend.binding, key: 'audio/lesson.mp3' };
      await transaction(async (tx) => {
        await new StorageBackendRegistry(tx, 'sqlite', 'app').register(backend);
        const writes = new StorageWriteJournal(tx, 'sqlite', 'app');
        for (const job of [previous, next]) {
          const intent = prepareStorageWrite({
            namespace: 'app',
            subjectId: job.subjectId,
            generation: job.generation,
            target,
          });
          await writes.begin(intent, job.generation);
          await writes.finish(intent, { kind: 'unreferenced' });
        }
        const journal = new StorageCleanupJournal(tx, 'sqlite', 'app');
        for (const job of [previous, next]) {
          await journal.createJob(job);
          await journal.registerCollectors(job.id, job.epoch, [
            { id: 'inventory', kind: 'inventory', backendIds: [backend.id], scope: target.key, match: 'key' },
          ]);
        }
      });
      const objects = new Set([target.key]);
      const remove = vi.fn(async (key: string) => {
        objects.delete(key);
      });
      const run = (jobId: string) =>
        runStorageCleanup({
          namespace: 'app',
          dialect: 'sqlite',
          jobId,
          transaction,
          executor: (tx) => tx,
          ports: [
            {
              backendId: backend.id,
              binding: backend.binding,
              collect: async () => ({ targets: objects.has(target.key) ? [target] : [], next: null }),
              delete: remove,
            },
          ],
        });
      await run(previous.id);
      expect(remove).toHaveBeenCalledTimes(1);
      if (damage === 'no-retention-policy') {
        await run(next.id);
        expect(remove).toHaveBeenCalledTimes(2);
        return;
      }
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const namespace = digest('app');
      const tombstoneId = `sd-t:1:${namespace}:${digest(previous.subjectId)}`;
      const targetId = `sd-d:1:${namespace}:${previous.id}:${digest(JSON.stringify([target.binding, target.key]))}`;
      const priorJobId = `sd-c:1:${namespace}:${previous.id}`;
      const retentionId = `sd-jr:1:${namespace}:${previous.id}`;
      if (damage === 'missing-retention-proof')
        database.prepare('DELETE FROM SidedoorState WHERE id = ?').run(retentionId);
      if (damage === 'changed-retention-proof')
        database
          .prepare("UPDATE SidedoorState SET state = json_set(state, '$.binding', ?) WHERE id = ?")
          .run('0'.repeat(64), retentionId);
      if (damage === 'incomplete-retention-proof')
        database
          .prepare("UPDATE SidedoorState SET state = json_set(state, '$.phase', 'jobs') WHERE id = ?")
          .run(retentionId);
      if (damage === 'incomplete-counters')
        database
          .prepare(
            "UPDATE SidedoorState SET state = json_set(state, '$.remainingCollectors', 1) WHERE id = ?",
          )
          .run(priorJobId);
      if (damage === 'missing-retention')
        database
          .prepare("UPDATE SidedoorState SET state = json_remove(state, '$.retentionPolicy') WHERE id = ?")
          .run(priorJobId);
      if (damage === 'missing-tombstone')
        database.prepare('DELETE FROM SidedoorState WHERE id = ?').run(tombstoneId);
      if (damage === 'wrong-tombstone')
        database
          .prepare("UPDATE SidedoorState SET state = json_set(state, '$.jobId', ?) WHERE id = ?")
          .run(randomUUID(), tombstoneId);
      if (damage === 'missing-target')
        database.prepare('DELETE FROM SidedoorState WHERE id = ?').run(targetId);
      if (damage === 'pending-target')
        database
          .prepare("UPDATE SidedoorState SET state = json_set(state, '$.status', 'pending') WHERE id = ?")
          .run(targetId);
      if (damage === 'wrong-target')
        database
          .prepare(
            "UPDATE SidedoorState SET state = json_set(state, '$.key', 'audio/other.mp3') WHERE id = ?",
          )
          .run(targetId);
      if (damage === 'unconfirmed-execution')
        database
          .prepare(
            "UPDATE SidedoorState SET state = json_set(state, '$.status', 'unconfirmed') WHERE id LIKE 'sd-ce:1:%' AND json_extract(state, '$.jobId') = ?",
          )
          .run(previous.id);
      if (damage === 'foreign-predecessor') {
        const foreign = prepareStorageCleanup({
          namespace: 'other',
          subjectId: 'profile:foreign',
          generation: 1,
          retentionPolicy: 'job-id-snapshots-v1',
        });
        await transaction((tx) => new StorageCleanupJournal(tx, 'sqlite', 'other').createJob(foreign));
        const foreignPrefix = digest('other');
        const foreignJobId = `sd-c:1:${foreignPrefix}:${foreign.id}`;
        database
          .prepare("UPDATE SidedoorState SET state = json_set(state, '$.phase', 'complete') WHERE id = ?")
          .run(foreignJobId);
        const targetState = database
          .prepare('SELECT state FROM SidedoorState WHERE id = ?')
          .get(targetId) as { state: string };
        const foreignTarget = { ...JSON.parse(targetState.state), namespace: 'other', jobId: foreign.id };
        database
          .prepare('INSERT INTO SidedoorState (id,revision,state) VALUES (?,?,?)')
          .run(
            `sd-d:1:${foreignPrefix}:${foreign.id}:${digest(JSON.stringify([target.binding, target.key]))}`,
            randomUUID(),
            JSON.stringify(foreignTarget),
          );
        database
          .prepare("UPDATE SidedoorState SET state = json_set(state, '$.retirement', ?) WHERE id = ?")
          .run(digest(foreign.id), `sd-tf:1:${digest(JSON.stringify([target.binding, target.key]))}`);
      }
      await expect(run(next.id)).rejects.toThrow();
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });
  it('does not treat a foreign execution with the same UUID as the current owner', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(
      'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
    );
    try {
      const query = async (sql: string, values: readonly unknown[]) =>
        database.prepare(sql).all(...(values as SQLInputValue[]));
      const journal = new CleanupExecutionJournal({ query }, 'sqlite', 'app');
      const priorJob = randomUUID();
      const currentJob = randomUUID();
      const activeId = randomUUID();
      const binding = 'a'.repeat(64);
      const insert = (
        namespace: string,
        executionId: string,
        jobId: string,
        status: 'active' | 'settled',
      ) => {
        const prefix = createHash('sha256').update(namespace).digest('hex');
        database
          .prepare('INSERT INTO SidedoorState (id,revision,state) VALUES (?,?,?)')
          .run(
            `sd-ce:1:${prefix}:${executionId}`,
            randomUUID(),
            JSON.stringify({ executionId, executorId: randomUUID(), jobId, backendBinding: binding, status }),
          );
      };
      insert('app', randomUUID(), priorJob, 'settled');
      insert('app', activeId, currentJob, 'active');
      expect(await journal.hasSettled(priorJob, binding, activeId, currentJob)).toBe(true);
      insert('other', activeId, randomUUID(), 'active');
      expect(await journal.hasSettled(priorJob, binding, activeId, currentJob)).toBe(false);
    } finally {
      database.close();
    }
  });
  it.each(['unknown', 'incomplete'] as const)(
    'refuses a target retired by an %s job without completed deletion proof',
    async (mode) => {
      const database = new DatabaseSync(':memory:');
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
      try {
        const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
        const backend = prepareStorageBackend('app', {
          kind: 'object',
          location,
          binding: storageBackendBinding(location),
        });
        const job = prepareStorageCleanup({
          namespace: 'app',
          subjectId: 'profile:one',
          generation: 1,
          retentionPolicy: 'job-id-snapshots-v1',
        });
        const previous = prepareStorageCleanup({
          namespace: 'app',
          subjectId: 'profile:other',
          generation: 1,
          retentionPolicy: 'job-id-snapshots-v1',
        });
        const target = { backendId: backend.id, binding: backend.binding, key: 'audio/lesson.mp3' };
        await transaction(async (tx) => {
          await new StorageBackendRegistry(tx, 'sqlite', 'app').register(backend);
          const journal = new StorageCleanupJournal(tx, 'sqlite', 'app');
          await journal.createJob(job);
          if (mode === 'incomplete') await journal.createJob(previous);
          await journal.registerCollectors(job.id, job.epoch, [
            { id: 'inventory', kind: 'inventory', backendIds: [backend.id], scope: target.key, match: 'key' },
          ]);
          await new StorageTargetFence(tx, 'sqlite').retire({ ...target, retirementId: previous.id });
        });
        const remove = vi.fn();
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
                collect: async () => ({ targets: [target], next: null }),
                delete: remove,
              },
            ],
          }),
        ).rejects.toThrow('Storage target has another retirement');
        expect(remove).not.toHaveBeenCalled();
      } finally {
        database.close();
      }
    },
  );
});
