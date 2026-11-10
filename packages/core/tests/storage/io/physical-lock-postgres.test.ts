import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { acquirePostgresBackendLock } from '../../../src/storage/registry/backend-lock';
import { acquirePostgresBackendLockGroup } from '../../../src/storage/registry/backend-lock-group';
import { openPostgresDedicatedConnection } from '../../../src/storage/sql/postgres-connection';
import { CleanupExecutionJournal } from '../../../src/storage/cleanup/cleanup-execution';
import { StorageCleanupJournal } from '../../../src/storage/cleanup/cleanup-journal';
import { prepareStorageCleanup } from '../../../src/storage/cleanup/cleanup-state';
import {
  prepareStorageBackend,
  StorageBackendRegistry,
} from '../../../src/storage/registry/backend-registry';
import { storageBackendBinding } from '../../../src/storage/registry/references';
import type { SqlExecutor } from '../../../src/storage/sql/sql';

function latch() {
  let notify: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    notify = resolve;
  });
  return {
    promise,
    resolve() {
      if (!notify) throw new Error('Latch is unavailable');
      notify();
    },
  };
}

const suite = process.env.SIDEDOOR_TEST_DATABASE_URL ? describe : describe.skip;
const openConnection = () => {
  const client = new Client({ connectionString: process.env.SIDEDOOR_TEST_DATABASE_URL });
  return openPostgresDedicatedConnection(
    {
      async connect() {
        await client.connect();
      },
      end: () => client.end(),
      async query(sql, values) {
        return (await client.query(sql, [...values])).rows;
      },
      onError(listener) {
        client.on('error', listener);
        return () => client.off('error', listener);
      },
      onEnd(listener) {
        client.on('end', listener);
        return () => client.off('end', listener);
      },
    },
    { connectMs: 10_000, queryMs: 10_000, closeMs: 10_000 },
  );
};
suite('physical backend lock with PostgreSQL', () => {
  it('excludes different namespaces until the owning session releases the backend', async () => {
    const binding = randomUUID().replaceAll('-', '').repeat(2);
    const first = await acquirePostgresBackendLock({ namespace: 'first', binding, openConnection });
    try {
      await expect(
        acquirePostgresBackendLock({ namespace: 'second', binding, openConnection }),
      ).rejects.toThrow('owned by another');
    } finally {
      await first.release();
    }
    const second = await acquirePostgresBackendLock({ namespace: 'second', binding, openConnection });
    await second.release();
  });

  it('holds every backend lock through serializable transactions on the same session', async () => {
    const first = randomUUID().replaceAll('-', '').repeat(2);
    const second = randomUUID().replaceAll('-', '').repeat(2);
    const group = await acquirePostgresBackendLockGroup({ bindings: [second, first], openConnection });
    try {
      const captured: { transaction: SqlExecutor | null } = { transaction: null };
      await group.transaction(async (tx) => {
        captured.transaction = tx;
        await tx.query('CREATE TEMP TABLE owned_cleanup_test (value INTEGER)', []);
        await tx.query('INSERT INTO owned_cleanup_test (value) VALUES (1)', []);
      });
      if (!captured.transaction) throw new Error('Missing transaction executor');
      await expect(captured.transaction.query('SELECT 1', [])).rejects.toThrow('no longer active');
      const started = latch();
      const release = latch();
      const active = group.transaction(async (tx) => {
        started.resolve();
        await release.promise;
        await tx.query('SELECT 1', []);
      });
      await started.promise;
      try {
        await expect(group.transaction(async () => undefined)).rejects.toThrow('already active');
        await expect(group.release()).rejects.toThrow('during a transaction');
      } finally {
        release.resolve();
      }
      await active;
      await expect(
        acquirePostgresBackendLock({ namespace: 'other', binding: first, openConnection }),
      ).rejects.toThrow('owned by another');
      await expect(
        group.transaction(async (tx) => {
          await tx.query('INSERT INTO owned_cleanup_test (value) VALUES (2)', []);
          throw new Error('transaction aborted');
        }),
      ).rejects.toThrow('transaction aborted');
      const rows = await group.transaction((tx) =>
        tx.query('SELECT value FROM owned_cleanup_test ORDER BY value', []),
      );
      expect(rows).toEqual([{ value: 1 }]);
    } finally {
      await group.release();
    }
    const released = await acquirePostgresBackendLock({
      namespace: 'other',
      binding: second,
      openConnection,
    });
    await released.release();
  });

  it('releases earlier locks if one lock in a group is already owned', async () => {
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    const occupied = await acquirePostgresBackendLock({
      namespace: 'other',
      binding: second,
      openConnection,
    });
    try {
      await expect(
        acquirePostgresBackendLockGroup({ bindings: [second, first], openConnection }),
      ).rejects.toThrow('owned by another');
      const available = await acquirePostgresBackendLock({
        namespace: 'other',
        binding: first,
        openConnection,
      });
      await available.release();
    } finally {
      await occupied.release();
    }
  });

  it('rolls back an in-flight journal transaction when the lock session dies', async () => {
    const admin = new Client({ connectionString: process.env.SIDEDOOR_TEST_DATABASE_URL });
    const schema = `lock_loss_${randomUUID().replaceAll('-', '')}`;
    const binding = randomUUID().replaceAll('-', '').repeat(2);
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`CREATE TABLE "${schema}".records (value INTEGER)`);
      const group = await acquirePostgresBackendLockGroup({ bindings: [binding], openConnection });
      try {
        await expect(
          group.transaction(async (tx) => {
            const rows = await tx.query('SELECT pg_backend_pid() AS pid', []);
            const pid = rows[0]?.pid;
            if (typeof pid !== 'number') throw new Error('Missing backend process ID');
            await tx.query(`INSERT INTO "${schema}".records (value) VALUES (1)`, []);
            await admin.query('SELECT pg_terminate_backend($1)', [pid]);
            await tx.query('SELECT 1', []);
          }),
        ).rejects.toThrow();
      } finally {
        await group.release();
      }
      expect((await admin.query(`SELECT value FROM "${schema}".records`)).rows).toEqual([]);
      const successor = await acquirePostgresBackendLock({ namespace: 'other', binding, openConnection });
      await successor.release();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }, 30_000);

  it('serializes concurrent namespace admissions to the same durable backend gate', async () => {
    const connectionString = process.env.SIDEDOOR_TEST_DATABASE_URL;
    const admin = new Client({ connectionString });
    const firstClient = new Client({ connectionString });
    const secondClient = new Client({ connectionString });
    const schema = `global_gate_${randomUUID().replaceAll('-', '')}`;
    const execute = (client: Client) => ({
      async query(sql: string, values: readonly unknown[]) {
        return (await client.query(sql, [...values])).rows;
      },
    });
    await Promise.all([admin.connect(), firstClient.connect(), secondClient.connect()]);
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(
        `CREATE TABLE "${schema}"."SidedoorState" (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state JSONB NOT NULL)`,
      );
      await admin.query(`CREATE INDEX ON "${schema}"."SidedoorState" (id text_pattern_ops)`);
      await Promise.all([
        admin.query(`SET search_path TO "${schema}"`),
        firstClient.query(`SET search_path TO "${schema}"`),
        secondClient.query(`SET search_path TO "${schema}"`),
      ]);
      const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
      const descriptor = { kind: 'object' as const, location, binding: storageBackendBinding(location) };
      const firstBackend = prepareStorageBackend('first', descriptor);
      const secondBackend = prepareStorageBackend('second', descriptor);
      const firstJob = prepareStorageCleanup({
        namespace: 'first',
        subjectId: 'first-learner',
        generation: 1,
      });
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
      await admin.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      for (const [namespace, backend, job] of [
        ['first', firstBackend, firstJob],
        ['second', secondBackend, secondJob],
      ] as const) {
        await new StorageBackendRegistry(execute(admin), 'postgres', namespace).register(backend);
        const cleanup = new StorageCleanupJournal(execute(admin), 'postgres', namespace);
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
      await admin.query('COMMIT');
      await firstClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await new CleanupExecutionJournal(execute(firstClient), 'postgres', 'first').begin(first);
      await secondClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      let notifyDispatch: (() => void) | undefined;
      const dispatched = new Promise<void>((resolve) => {
        notifyDispatch = resolve;
      });
      const racingExecutor = {
        async query(sql: string, values: readonly unknown[]) {
          const result = secondClient.query(sql, [...values]);
          if (sql.startsWith('INSERT INTO "SidedoorState"') && String(values[0]).startsWith('sd-ceg:2:'))
            notifyDispatch?.();
          return (await result).rows;
        },
      };
      const result = new CleanupExecutionJournal(racingExecutor, 'postgres', 'second').begin(second).then(
        () => null,
        (error: unknown) => error,
      );
      await dispatched;
      await firstClient.query('COMMIT');
      expect(await result).toMatchObject({ code: '40001' });
      await secondClient.query('ROLLBACK');
      await secondClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(
        new CleanupExecutionJournal(execute(secondClient), 'postgres', 'second').begin(second),
      ).rejects.toThrow('unresolved');
      await secondClient.query('ROLLBACK');
    } finally {
      await Promise.allSettled([firstClient.query('ROLLBACK'), secondClient.query('ROLLBACK')]);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await Promise.allSettled([admin.end(), firstClient.end(), secondClient.end()]);
    }
  }, 30_000);
});
