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
