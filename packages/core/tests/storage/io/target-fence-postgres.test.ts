import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageTargetFence } from '../../../src/storage/execution/target-fence';
import { StorageWriteJournal, prepareStorageWrite } from '../../../src/storage/execution/write-journal';
import {
  StorageBackendRegistry,
  prepareStorageBackend,
} from '../../../src/storage/registry/backend-registry';
import {
  StorageReferenceRegistry,
  prepareStorageReference,
} from '../../../src/storage/registry/reference-registry';
import { storageBackendBinding } from '../../../src/storage/registry/references';
import { StorageCleanupJournal } from '../../../src/storage/cleanup/cleanup-journal';
import { CleanupExecutionJournal } from '../../../src/storage/cleanup/cleanup-execution';
import { prepareStorageCleanup } from '../../../src/storage/cleanup/cleanup-state';

const suite = process.env.SIDEDOOR_TEST_DATABASE_URL ? describe : describe.skip;
suite('storage target fence with concurrent PostgreSQL transactions', () => {
  const schema = `target_fence_${randomUUID().replaceAll('-', '')}`;
  let admin: Client;
  let writer: Client;
  let cleaner: Client;

  beforeAll(async () => {
    const connectionString = process.env.SIDEDOOR_TEST_DATABASE_URL;
    admin = new Client({ connectionString });
    writer = new Client({ connectionString });
    cleaner = new Client({ connectionString });
    await Promise.all([admin.connect(), writer.connect(), cleaner.connect()]);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(
      `CREATE TABLE "${schema}"."SidedoorState" (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state JSONB NOT NULL)`,
    );
    await admin.query(`CREATE INDEX ON "${schema}"."SidedoorState" (id text_pattern_ops)`);
    await Promise.all([
      writer.query(`SET search_path TO "${schema}"`),
      cleaner.query(`SET search_path TO "${schema}"`),
    ]);
  });

  afterAll(async () => {
    await Promise.allSettled([writer?.query('ROLLBACK'), cleaner?.query('ROLLBACK')]);
    if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await Promise.allSettled([admin?.end(), writer?.end(), cleaner?.end()]);
  });

  it('restarts a completed inventory when uncertain ownership is resolved', async () => {
    const namespace = `recovery:${randomUUID()}`;
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
    const backend = prepareStorageBackend(namespace, {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
    });
    const job = prepareStorageCleanup({ namespace, subjectId: `subject:${randomUUID()}`, generation: 1 });
    const target = { backendId: backend.id, binding: backend.binding, key: 'newly-discovered.pdf' };
    const execution = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: job.id,
      backendBinding: backend.binding,
    };
    const database = {
      query: async (sql: string, values: readonly unknown[]) => (await cleaner.query(sql, [...values])).rows,
    };
    const cleanup = new StorageCleanupJournal(database, 'postgres', namespace);
    const executions = new CleanupExecutionJournal(database, 'postgres', namespace);
    await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await new StorageBackendRegistry(database, 'postgres', namespace).register(backend);
    await cleanup.createJob(job);
    await cleanup.registerCollectors(job.id, job.epoch, [
      { id: 'inventory', kind: 'inventory', backendIds: [backend.id], scope: target.key, match: 'key' },
    ]);
    await executions.begin(execution);
    let current = await executions.transition(job.id, job.epoch, [execution]);
    current = await cleanup.recordDrainedIntents(job.id, current.epoch, null);
    current = await cleanup.recordCollectorPage({
      jobId: job.id,
      epoch: current.epoch,
      collectorId: 'inventory',
      after: null,
      next: null,
      targets: [],
    });
    current = await executions.transition(job.id, current.epoch, [execution]);
    current = await executions.transition(job.id, current.epoch, [execution]);
    current = await cleanup.beginVerification(job.id, current.epoch);
    current = await cleanup.recordCollectorPage({
      jobId: job.id,
      epoch: current.epoch,
      collectorId: 'inventory',
      after: null,
      next: null,
      targets: [],
    });
    current = await executions.transition(job.id, current.epoch, [execution]);
    expect(current.phase).toBe('complete');
    await executions.markUnconfirmed(execution);
    await cleaner.query('COMMIT');
    await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await executions.resolveUnconfirmed(execution, { id: randomUUID(), kind: 'remote-operations-settled' });
    current = await cleanup.get(job.id);
    expect(current.phase).toBe('verifying');
    const replacement = { ...execution, executionId: randomUUID(), executorId: randomUUID() };
    await executions.begin(replacement);
    current = await cleanup.recordCollectorPage({
      jobId: job.id,
      epoch: current.epoch,
      collectorId: 'inventory',
      after: null,
      next: null,
      targets: [target],
    });
    current = await executions.transition(job.id, current.epoch, [replacement]);
    expect(current.phase).toBe('deleting');
    expect(
      (await cleanup.pendingTargets(job.id, current.epoch)).tickets.map((item) => item.target.key),
    ).toEqual([target.key]);
    await cleaner.query('COMMIT');
  });

  it('rejects a successor inventory page racing detached execution recovery', async () => {
    const namespace = `recovery-race:${randomUUID()}`;
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
    const backend = prepareStorageBackend(namespace, {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
    });
    const job = prepareStorageCleanup({ namespace, subjectId: `subject:${randomUUID()}`, generation: 1 });
    const first = {
      executionId: randomUUID(),
      executorId: randomUUID(),
      jobId: job.id,
      backendBinding: backend.binding,
    };
    const second = { ...first, executionId: randomUUID(), executorId: randomUUID() };
    const execute = (client: Client) => ({
      async query(sql: string, values: readonly unknown[]) {
        return (await client.query(sql, [...values])).rows;
      },
    });
    const cleanup = new StorageCleanupJournal(execute(cleaner), 'postgres', namespace);
    const executions = new CleanupExecutionJournal(execute(cleaner), 'postgres', namespace);
    await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await new StorageBackendRegistry(execute(cleaner), 'postgres', namespace).register(backend);
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
    await executions.begin(second);
    await executions.markUnconfirmed(first);
    let current = await executions.transition(job.id, job.epoch, [second]);
    current = await cleanup.recordDrainedIntents(job.id, current.epoch, null);
    expect(current.phase).toBe('collecting');
    await cleaner.query('COMMIT');

    await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await executions.resolveUnconfirmed(first, { id: randomUUID(), kind: 'remote-operations-settled' });
    await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    let signalUpdate: (() => void) | undefined;
    const dispatched = new Promise<void>((resolve) => {
      signalUpdate = resolve;
    });
    const concurrent = {
      async query(sql: string, values: readonly unknown[]) {
        const result = writer.query(sql, [...values]);
        if (sql.startsWith('UPDATE "SidedoorState"')) signalUpdate?.();
        return (await result).rows;
      },
    };
    const outcome = new StorageCleanupJournal(concurrent, 'postgres', namespace)
      .recordCollectorPage({
        jobId: job.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [],
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await dispatched;
    await cleaner.query('COMMIT');
    expect(await outcome).toMatchObject({ code: '40001' });
    await writer.query('ROLLBACK');
    await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await expect(
      new StorageCleanupJournal(execute(writer), 'postgres', namespace).recordCollectorPage({
        jobId: job.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [],
      }),
    ).rejects.toThrow('phase changed');
    await writer.query('ROLLBACK');
    expect(await executions.current(backend.binding)).toMatchObject({
      executionId: second.executionId,
      status: 'active',
    });
  }, 30_000);

  it('finds retained work after scanning ten thousand older intents', async () => {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    let namespace = randomUUID();
    while (hash(namespace) < hash('app')) namespace = randomUUID();
    const subjects = Array.from({ length: 10_001 }, (_, index) => `learner:${index}`).sort((left, right) =>
      hash(left).localeCompare(hash(right)),
    );
    const ids: string[] = [];
    const revisions: string[] = [];
    const states: string[] = [];
    let lastTarget = { backendId: 'a'.repeat(64), binding: 'b'.repeat(64), key: 'unused' };
    for (const [index, subjectId] of subjects.entries()) {
      const target = { backendId: 'a'.repeat(64), binding: 'b'.repeat(64), key: `recordings/${index}.wav` };
      const intent = prepareStorageWrite({ namespace, subjectId, generation: 1, target });
      ids.push(`sd-w:1:${hash(namespace)}:${hash(subjectId)}:${intent.operationId}`);
      revisions.push(randomUUID());
      states.push(JSON.stringify(intent));
      lastTarget = target;
    }
    await writer.query(
      'INSERT INTO "SidedoorState" (id, revision, state) SELECT id, revision, state::jsonb FROM unnest($1::text[], $2::text[], $3::text[]) AS records(id, revision, state)',
      [ids, revisions, states],
    );
    await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const executor = {
      async query(sql: string, values: readonly unknown[]) {
        return (await cleaner.query(sql, [...values])).rows;
      },
    };
    await expect(
      new StorageTargetFence(executor, 'postgres').retire({ ...lastTarget, retirementId: randomUUID() }),
    ).rejects.toThrow('retained writes');
    await cleaner.query('ROLLBACK');
    await writer.query('DELETE FROM "SidedoorState" WHERE id LIKE $1', [`sd-w:1:${hash(namespace)}:%`]);
  }, 30_000);

  it.each(['write', 'reference'] as const)(
    'does not retire a target while a concurrent %s admission commits',
    async (kind) => {
      const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
      const backend = prepareStorageBackend('app', {
        kind: 'object',
        location,
        binding: storageBackendBinding(location),
        publicUrl: 'https://media.example',
      });
      const target = { backendId: backend.id, binding: backend.binding, key: `${randomUUID()}.pdf` };
      const execute = (client: Client) => ({
        async query(sql: string, values: readonly unknown[]) {
          return (await client.query(sql, [...values])).rows;
        },
      });
      await new StorageBackendRegistry(execute(writer), 'postgres', 'app').register(backend);
      await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      if (kind === 'write') {
        const intent = prepareStorageWrite({ namespace: 'app', subjectId: 'learner', generation: 1, target });
        await new StorageWriteJournal(execute(writer), 'postgres', 'app').begin(intent, 1);
      } else {
        const next = prepareStorageReference({
          namespace: 'app',
          operationId: randomUUID(),
          reference: `https://media.example/${target.key}`,
          target,
          scopes: [{ subjectId: 'learner', generation: 1 }],
        });
        await new StorageReferenceRegistry(execute(writer), 'postgres', 'app').replace({
          consumer: 'learner:worksheet',
          previousReference: null,
          next,
        });
      }
      await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      let notifyDispatch = () => {};
      const dispatched = new Promise<void>((resolve) => {
        notifyDispatch = resolve;
      });
      const cleanupExecutor = {
        async query(sql: string, values: readonly unknown[]) {
          const result = cleaner.query(sql, [...values]);
          if (sql.startsWith('INSERT INTO "SidedoorState"') && String(values[0]).startsWith('sd-tf:'))
            notifyDispatch();
          return (await result).rows;
        },
      };
      const attempt = new StorageTargetFence(cleanupExecutor, 'postgres').retire({
        ...target,
        retirementId: randomUUID(),
      });
      const outcome = attempt.then(
        () => null,
        (error: unknown) => error,
      );
      await dispatched;
      await writer.query('COMMIT');
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: '40001' });
      await cleaner.query('ROLLBACK');
      await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(
        new StorageTargetFence(execute(cleaner), 'postgres').retire({
          ...target,
          retirementId: randomUUID(),
        }),
      ).rejects.toThrow(kind === 'write' ? 'retained writes' : 'live consumers');
      await cleaner.query('ROLLBACK');
    },
    30_000,
  );

  it.each(['writer', 'cleanup'] as const)(
    'does not dispatch deletion when a cross-namespace reference and %s commit race',
    async (first) => {
      const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
      const descriptor = {
        kind: 'object' as const,
        location,
        binding: storageBackendBinding(location),
        publicUrl: 'https://media.example',
      };
      const backend = prepareStorageBackend('app', descriptor);
      const other = prepareStorageBackend('other', descriptor);
      const target = { backendId: backend.id, binding: backend.binding, key: `${randomUUID()}.pdf` };
      const execute = (client: Client) => ({
        async query(sql: string, values: readonly unknown[]) {
          return (await client.query(sql, [...values])).rows;
        },
      });
      const cleanup = new StorageCleanupJournal(execute(cleaner), 'postgres', 'app');
      const executions = new CleanupExecutionJournal(execute(cleaner), 'postgres', 'app');
      const job = prepareStorageCleanup({
        namespace: 'app',
        subjectId: `deleted:${randomUUID()}`,
        generation: 1,
      });
      const binding = {
        executionId: randomUUID(),
        executorId: randomUUID(),
        jobId: job.id,
        backendBinding: backend.binding,
      };
      await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await new StorageBackendRegistry(execute(cleaner), 'postgres', 'app').register(backend);
      await new StorageBackendRegistry(execute(cleaner), 'postgres', 'other').register(other);
      await cleanup.createJob(job);
      await cleanup.registerCollectors(job.id, job.epoch, [
        { id: 'inventory', kind: 'inventory', backendIds: [backend.id], scope: target.key, match: 'key' },
      ]);
      await executions.begin(binding);
      let current = await executions.transition(job.id, job.epoch, [binding]);
      current = await cleanup.recordDrainedIntents(job.id, current.epoch, null);
      current = await cleanup.recordCollectorPage({
        jobId: job.id,
        epoch: current.epoch,
        collectorId: 'inventory',
        after: null,
        next: null,
        targets: [target],
      });
      current = await executions.transition(job.id, current.epoch, [binding]);
      current = await executions.transition(job.id, current.epoch, [binding]);
      const ticket = (await cleanup.pendingTargets(job.id, current.epoch)).tickets[0];
      if (!ticket) throw new Error('Missing cleanup ticket');
      await cleaner.query('COMMIT');
      const reference = prepareStorageReference({
        namespace: 'other',
        operationId: randomUUID(),
        reference: `https://media.example/${target.key}`,
        target: { ...target, backendId: other.id },
        scopes: [{ subjectId: 'profile:survivor', generation: 1 }],
      });
      const owner = new StorageReferenceRegistry(execute(writer), 'postgres', 'other');
      if (first === 'writer') {
        await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await owner.replace({ consumer: 'survivor:avatar', previousReference: null, next: reference });
        await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        let notifyDispatch = () => {};
        const dispatched = new Promise<void>((resolve) => {
          notifyDispatch = resolve;
        });
        const guarded = {
          async query(sql: string, values: readonly unknown[]) {
            const result = cleaner.query(sql, [...values]);
            if (sql.startsWith('INSERT INTO "SidedoorState"') && String(values[0]).startsWith('sd-tf:'))
              notifyDispatch();
            return (await result).rows;
          },
        };
        const attempt = new CleanupExecutionJournal(guarded, 'postgres', 'app')
          .authorizeTarget(binding, ticket)
          .then(
            () => null,
            (error: unknown) => error,
          );
        await dispatched;
        await writer.query('COMMIT');
        expect(await attempt).toMatchObject({ code: '40001' });
        await cleaner.query('ROLLBACK');
        await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await expect(executions.authorizeTarget(binding, ticket)).rejects.toThrow('live consumers');
        await cleaner.query('ROLLBACK');
        expect(
          await owner.resolve({ consumer: 'survivor:avatar', reference: reference.reference }),
        ).not.toBeNull();
      } else {
        await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await executions.authorizeTarget(binding, ticket);
        await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        let notifyDispatch = () => {};
        const dispatched = new Promise<void>((resolve) => {
          notifyDispatch = resolve;
        });
        const guarded = {
          async query(sql: string, values: readonly unknown[]) {
            const result = writer.query(sql, [...values]);
            if (sql.startsWith('INSERT INTO "SidedoorState"') && String(values[0]).startsWith('sd-tf:'))
              notifyDispatch();
            return (await result).rows;
          },
        };
        const attempt = new StorageReferenceRegistry(guarded, 'postgres', 'other')
          .replace({ consumer: 'survivor:avatar', previousReference: null, next: reference })
          .then(
            () => null,
            (error: unknown) => error,
          );
        await dispatched;
        await cleaner.query('COMMIT');
        expect(await attempt).toMatchObject({ code: '40001' });
        await writer.query('ROLLBACK');
        await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await expect(
          owner.replace({ consumer: 'survivor:avatar', previousReference: null, next: reference }),
        ).rejects.toThrow('target is retired');
        await writer.query('ROLLBACK');
      }
    },
    30_000,
  );

  it.each(['write', 'reference'] as const)(
    'does not admit a concurrent %s after target retirement commits',
    async (kind) => {
      const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
      const backend = prepareStorageBackend('app', {
        kind: 'object',
        location,
        binding: storageBackendBinding(location),
        publicUrl: 'https://media.example',
      });
      const target = { backendId: backend.id, binding: backend.binding, key: `${randomUUID()}.pdf` };
      const execute = (client: Client) => ({
        async query(sql: string, values: readonly unknown[]) {
          return (await client.query(sql, [...values])).rows;
        },
      });
      await new StorageBackendRegistry(execute(writer), 'postgres', 'app').register(backend);
      await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await new StorageTargetFence(execute(cleaner), 'postgres').retire({
        ...target,
        retirementId: randomUUID(),
      });
      await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      let notifyDispatch = () => {};
      const dispatched = new Promise<void>((resolve) => {
        notifyDispatch = resolve;
      });
      const writerExecutor = {
        async query(sql: string, values: readonly unknown[]) {
          const result = writer.query(sql, [...values]);
          if (sql.startsWith('INSERT INTO "SidedoorState"') && String(values[0]).startsWith('sd-tf:'))
            notifyDispatch();
          return (await result).rows;
        },
      };
      const intent = prepareStorageWrite({ namespace: 'app', subjectId: 'learner', generation: 1, target });
      const next = prepareStorageReference({
        namespace: 'app',
        operationId: randomUUID(),
        reference: `https://media.example/${target.key}`,
        target,
        scopes: [{ subjectId: 'learner', generation: 1 }],
      });
      const admit = () =>
        kind === 'write'
          ? new StorageWriteJournal(writerExecutor, 'postgres', 'app').begin(intent, 1)
          : new StorageReferenceRegistry(writerExecutor, 'postgres', 'app').replace({
              consumer: 'learner:worksheet',
              previousReference: null,
              next,
            });
      const outcome = admit().then(
        () => null,
        (error: unknown) => error,
      );
      await dispatched;
      await cleaner.query('COMMIT');
      expect(await outcome).toMatchObject({ code: '40001' });
      await writer.query('ROLLBACK');
      await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(admit()).rejects.toThrow('target is retired');
      await writer.query('ROLLBACK');
    },
    30_000,
  );
});
