import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { runStorageProbe, type StorageProbeOptions } from '../src/storage/probe';
import { StorageProbeCleanupError } from '../src/storage/probe-errors';
import { isJobExecutionCleanupFailure } from '../src/runtime/job-execution';
import { StorageInstanceControl } from '../src/storage/instance';
import { StorageCleanupJournal } from '../src/storage/cleanup-journal';
import { StorageWriteJournal, prepareStorageTombstone } from '../src/storage/write-journal';
import { storageBackendBinding } from '../src/storage/references';
import type { SqlExecutor } from '../src/storage/sql';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec('CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)');
  const executor: SqlExecutor = {
    async query(sql, values) {
      return db.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  async function transaction<Result>(run: (tx: SqlExecutor) => Promise<Result>) {
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
  const instance = await transaction((tx) =>
    new StorageInstanceControl(tx, 'sqlite', 'app').initialize(randomUUID()),
  );
  const cleanup = new StorageCleanupJournal(executor, 'sqlite', 'app');
  const writes = new StorageWriteJournal(executor, 'sqlite', 'app');
  const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'probe' };
  const objects = new Map<string, string>();
  const controller = new AbortController();
  const options: StorageProbeOptions<SqlExecutor, string> = {
    namespace: 'app',
    dialect: 'sqlite',
    signal: controller.signal,
    executorId: randomUUID(),
    transaction,
    executor: (tx) => tx,
    captureAdmission: async () => ({
      instanceId: instance.instanceId,
      scopes: [
        { subjectId: instance.subjectId, generation: 0 },
        { subjectId: 'profile:owner', generation: 1 },
      ],
      snapshot: 'original',
    }),
    validateAdmission: async (tx, admission) => {
      const current = await new StorageInstanceControl(tx, 'sqlite', 'app').read();
      if (admission.snapshot !== 'original' || current.instanceId !== admission.instanceId)
        throw new Error('Original admission changed');
    },
    capturePort: async () => ({
      descriptor: {
        kind: 'object',
        location,
        binding: storageBackendBinding(location),
        access: null,
        publicUrl: null,
        referenceEncoding: 'raw',
      },
      write: async (key, body) => {
        const jobs = await cleanup.listJobs();
        expect(jobs.jobs).toHaveLength(1);
        expect((await writes.list('profile:owner')).intents).toHaveLength(1);
        objects.set(key, Buffer.from(body as Uint8Array).toString());
        return `https://storage.example/${key}`;
      },
      has: async (key) => objects.has(key),
      delete: async (key) => {
        objects.delete(key);
      },
    }),
  };
  return { options, cleanup, writes, objects, controller, instance, db };
}

it('journals the probe before upload and returns only after verified deletion', async () => {
  const item = await fixture();
  const result = await runStorageProbe(item.options);
  expect(item.objects.size).toBe(0);
  expect(await item.cleanup.get(result.cleanupJobId)).toMatchObject({ phase: 'complete' });
  expect(await item.writes.tombstone('profile:owner')).toBeNull();
  expect((await item.writes.list('profile:owner')).intents[0]).toMatchObject({ outcome: 'unreferenced' });
});

it('retains uncertain writes and their cleanup job after an upload response is lost', async () => {
  const item = await fixture();
  const port = await item.options.capturePort();
  item.options.capturePort = async () => ({
    ...port,
    write: async (...args) => {
      await port.write(...args);
      throw new Error('Upload response lost');
    },
  });
  const failure = await runStorageProbe(item.options).catch((error) => error as unknown);
  expect(failure).toBeInstanceOf(StorageProbeCleanupError);
  expect(failure).toMatchObject({ cause: expect.objectContaining({ message: 'Upload response lost' }) });
  expect(isJobExecutionCleanupFailure(failure)).toBe(true);
  expect(item.objects.size).toBe(1);
  expect((await item.writes.list('profile:owner')).intents[0]).toMatchObject({ status: 'uncertain' });
  expect((await item.cleanup.listJobs()).jobs).toHaveLength(1);
});

it('recovers an accepted cleanup settlement without repeating external I/O', async () => {
  const item = await fixture();
  const transaction = item.options.transaction;
  let lost = false;
  item.options.transaction = async (run) => {
    const result = await transaction(run);
    if (
      !lost &&
      item.db
        .prepare(
          "SELECT id FROM SidedoorState WHERE id LIKE 'sd-ce:1:%' AND json_extract(state, '$.status') = 'settled'",
        )
        .get()
    ) {
      lost = true;
      throw new Error('Settlement COMMIT response lost');
    }
    return result;
  };
  const port = await item.options.capturePort();
  item.options.capturePort = async () => ({
    ...port,
    write: async (...args) => {
      if (lost) throw new Error('Unexpected second upload');
      return port.write(...args);
    },
    delete: async (key) => {
      if (lost) throw new Error('Unexpected repeated deletion');
      return port.delete(key);
    },
  });
  const result = await runStorageProbe(item.options);
  expect(lost).toBe(true);
  expect((await item.cleanup.get(result.cleanupJobId)).phase).toBe('complete');
  expect(item.objects.size).toBe(0);
});

it('preserves unresolved ownership when settlement recovery cannot read its receipt', async () => {
  const item = await fixture();
  const transaction = item.options.transaction;
  let disconnected = false;
  item.options.transaction = async (run) => {
    if (disconnected) throw new Error('Database unavailable during recovery');
    const result = await transaction(run);
    if (
      item.db
        .prepare(
          "SELECT id FROM SidedoorState WHERE id LIKE 'sd-ce:1:%' AND json_extract(state, '$.status') = 'settled'",
        )
        .get()
    ) {
      disconnected = true;
      throw new Error('Settlement COMMIT response lost');
    }
    return result;
  };
  const failure = await runStorageProbe(item.options).catch((error) => error as unknown);
  expect(failure).toBeInstanceOf(StorageProbeCleanupError);
  expect(isJobExecutionCleanupFailure(failure)).toBe(true);
  expect(item.objects.size).toBe(0);
});

it('retains deletion failures as cleanup uncertainty with the original cause', async () => {
  const item = await fixture();
  const port = await item.options.capturePort();
  const reason = new Error('Delete deadline exceeded');
  item.options.capturePort = async () => ({
    ...port,
    delete: async () => {
      throw reason;
    },
  });
  const failure = await runStorageProbe(item.options).catch((error) => error as unknown);
  expect(failure).toBeInstanceOf(StorageProbeCleanupError);
  expect(failure).toMatchObject({ cause: reason });
  expect(isJobExecutionCleanupFailure(failure)).toBe(true);
  expect(item.objects.size).toBe(1);
});

it('cleans a confirmed upload even when the caller cancels during the write', async () => {
  const item = await fixture();
  const port = await item.options.capturePort();
  const reason = new Error('Caller cancelled');
  item.options.capturePort = async () => ({
    ...port,
    write: async (...args) => {
      const url = await port.write(...args);
      item.controller.abort(reason);
      return url;
    },
  });
  await expect(runStorageProbe(item.options)).rejects.toBe(reason);
  expect(item.objects.size).toBe(0);
  expect((await item.cleanup.listJobs()).jobs[0]).toMatchObject({ phase: 'complete' });
});

it('settles an unstarted probe after a lost admission commit response', async () => {
  const item = await fixture();
  const transaction = item.options.transaction;
  let failed = false;
  item.options.transaction = async (run) => {
    const result = await transaction(run);
    if (!failed && (await item.cleanup.listJobs()).jobs.length === 1) {
      failed = true;
      throw new Error('Admission response lost');
    }
    return result;
  };
  await expect(runStorageProbe(item.options)).rejects.toThrow('Admission response lost');
  expect(item.objects.size).toBe(0);
  expect((await item.writes.list('profile:owner')).intents).toEqual([]);
  expect((await item.cleanup.listJobs()).jobs[0]).toMatchObject({ phase: 'complete' });
});

it('retains captured storage methods when the caller mutates its port after admission', async () => {
  const item = await fixture();
  const port = await item.options.capturePort();
  item.options.capturePort = async () => port;
  const transaction = item.options.transaction;
  let mutated = false;
  item.options.transaction = async (run) => {
    const result = await transaction(run);
    if (!mutated && (await item.cleanup.listJobs()).jobs.length === 1) {
      mutated = true;
      port.write = async () => {
        throw new Error('Replacement writer');
      };
      port.has = async () => {
        throw new Error('Replacement reader');
      };
      port.delete = async () => {
        throw new Error('Replacement deletion');
      };
    }
    return result;
  };
  const result = await runStorageProbe(item.options);
  expect(item.objects.size).toBe(0);
  expect(await item.cleanup.get(result.cleanupJobId)).toMatchObject({ phase: 'complete' });
});

it.each(['profile', 'instance'] as const)(
  'blocks %s erasure after admission before upload',
  async (scope) => {
    const item = await fixture();
    const transaction = item.options.transaction;
    let erased = false;
    item.options.transaction = async (run) => {
      const result = await transaction(run);
      if (!erased && (await item.cleanup.listJobs()).jobs.length === 1) {
        erased = true;
        await transaction(async () =>
          item.writes.forbidWrites(
            prepareStorageTombstone({
              namespace: 'app',
              subjectId: scope === 'profile' ? 'profile:owner' : item.instance.subjectId,
              generation: scope === 'profile' ? 1 : 0,
              jobId: randomUUID(),
            }),
          ),
        );
      }
      return result;
    };
    await expect(runStorageProbe(item.options)).rejects.toThrow('being erased');
    expect(item.objects.size).toBe(0);
    expect((await item.writes.list('profile:owner')).intents).toEqual([]);
    expect((await item.cleanup.listJobs()).jobs[0]).toMatchObject({ phase: 'complete' });
  },
);

it.each(['profile', 'instance'] as const)(
  'cleans uploaded bytes but rejects success after %s erasure',
  async (scope) => {
    const item = await fixture();
    const port = await item.options.capturePort();
    item.options.capturePort = async () => ({
      ...port,
      write: async (...args) => {
        const url = await port.write(...args);
        await item.options.transaction(async () =>
          item.writes.forbidWrites(
            prepareStorageTombstone({
              namespace: 'app',
              subjectId: scope === 'profile' ? 'profile:owner' : item.instance.subjectId,
              generation: scope === 'profile' ? 1 : 0,
              jobId: randomUUID(),
            }),
          ),
        );
        return url;
      },
    });
    await expect(runStorageProbe(item.options)).rejects.toThrow('being erased');
    expect(item.objects.size).toBe(0);
    expect((await item.cleanup.listJobs()).jobs[0]).toMatchObject({ phase: 'complete' });
  },
);
