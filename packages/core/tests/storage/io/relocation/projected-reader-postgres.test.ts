import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageRelocationRegistry } from '../../../../src/storage/local/relocation';
import {
  StorageBackendRegistry,
  prepareStorageBackend,
} from '../../../../src/storage/registry/backend-registry';
import {
  StorageReferenceRegistry,
  prepareStorageReference,
} from '../../../../src/storage/registry/reference-registry';
import { storageBackendBinding } from '../../../../src/storage/registry/references';
import { StorageCleanupJournal } from '../../../../src/storage/cleanup/cleanup-journal';
import { prepareStorageCleanup } from '../../../../src/storage/cleanup/cleanup-state';
import { StorageWriteJournal } from '../../../../src/storage/execution/write-journal';

const suite = process.env.SIDEDOOR_TEST_DATABASE_URL ? describe : describe.skip;
suite('projected relocation erasure with PostgreSQL', () => {
  const schema = `projected_reader_${randomUUID().replaceAll('-', '')}`;
  const namespace = 'test';
  let admin: Client;
  let cleaner: Client;
  let writer: Client;
  const executor = (client: Client) => ({
    async query(sql: string, values: readonly unknown[]) {
      return (await client.query(sql, [...values])).rows;
    },
  });
  beforeAll(async () => {
    const connectionString = process.env.SIDEDOOR_TEST_DATABASE_URL;
    admin = new Client({ connectionString });
    cleaner = new Client({ connectionString });
    writer = new Client({ connectionString });
    await Promise.all([admin.connect(), cleaner.connect(), writer.connect()]);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(
      `CREATE TABLE "${schema}"."SidedoorState" (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state JSONB NOT NULL)`,
    );
    await admin.query(`CREATE INDEX ON "${schema}"."SidedoorState" (id text_pattern_ops)`);
    await admin.query(
      `CREATE TABLE "${schema}"."ConsumerOwner" (consumer TEXT PRIMARY KEY, subject TEXT NOT NULL, generation BIGINT NOT NULL)`,
    );
    await Promise.all([
      cleaner.query(`SET search_path TO "${schema}"`),
      writer.query(`SET search_path TO "${schema}"`),
    ]);
  });
  afterAll(async () => {
    await Promise.allSettled([cleaner?.query('ROLLBACK'), writer?.query('ROLLBACK')]);
    if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await Promise.allSettled([admin?.end(), cleaner?.end(), writer?.end()]);
  });

  it('rolls back erasure when a concurrent authorized writer adds a live consumer', async () => {
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
    const backend = prepareStorageBackend(namespace, {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
      publicUrl: 'https://media.example',
    });
    const scope = { subjectId: 'profile:owner', generation: 1 };
    const prepared = (key: string, owner = scope) =>
      prepareStorageReference({
        namespace,
        operationId: randomUUID(),
        reference: `https://media.example/${key}`,
        target: { backendId: backend.id, binding: backend.binding, key },
        scopes: [owner],
      });
    const source = prepared('source');
    const destination = prepared('destination');
    const cleanerExecutor = executor(cleaner);
    const references = new StorageReferenceRegistry(cleanerExecutor, 'postgres', namespace);
    const relocations = new StorageRelocationRegistry(cleanerExecutor, 'postgres', namespace);
    await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await cleaner.query('INSERT INTO "ConsumerOwner" VALUES ($1, $2, $3)', [
      'owner:avatar',
      scope.subjectId,
      1,
    ]);
    await new StorageBackendRegistry(cleanerExecutor, 'postgres', namespace).register(backend);
    await references.replace({ consumer: 'owner:avatar', previousReference: null, next: source });
    const original = await references.readReference(source.reference);
    await references.replace({
      consumer: 'owner:avatar',
      previousReference: source.reference,
      next: destination,
    });
    const copied = await references.readReference(destination.reference);
    if (!original || !copied) throw new Error('Missing copied assets');
    const content = { sha256: createHash('sha256').update('same bytes').digest('hex'), bytes: 10 };
    await relocations.record({
      operationId: destination.operationId,
      sourceAssetId: original.asset.id,
      destinationAssetId: copied.asset.id,
      consumers: ['owner:avatar'],
      sourceRead: { assetId: original.asset.id, ...content },
      destinationRead: { assetId: copied.asset.id, ...content },
    });
    await references.retire({
      operationId: randomUUID(),
      consumer: 'owner:avatar',
      previousReference: destination.reference,
    });
    await cleaner.query(
      `UPDATE "SidedoorState" SET state = jsonb_set(state, '{schemaVersion}', '2'::jsonb) WHERE id LIKE 'sd-rel:1:%'`,
    );
    await cleaner.query('COMMIT');

    await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await writer.query('SELECT generation FROM "ConsumerOwner" WHERE consumer = $1', ['owner:avatar']);
    await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const job = prepareStorageCleanup({ namespace, ...scope, retentionPolicy: 'job-id-snapshots-v1' });
    await new StorageCleanupJournal(cleanerExecutor, 'postgres', namespace).createJob(job);
    await relocations.eraseForSubject({
      ...scope,
      jobId: job.id,
      epoch: job.epoch,
      verifyProjectedErasure: async (input) => {
        const result = await cleaner.query(
          'SELECT subject, generation FROM "ConsumerOwner" WHERE consumer = $1',
          [input.consumers[0]],
        );
        return (
          input.scopes.every(
            (item) => item.subjectId === input.subjectId && item.generation === input.generation,
          ) &&
          result.rows.length === 1 &&
          result.rows[0]?.subject === input.subjectId &&
          Number(result.rows[0]?.generation) === input.generation
        );
      },
    });
    await writer.query('UPDATE "ConsumerOwner" SET generation = $1 WHERE consumer = $2', [2, 'owner:avatar']);
    const concurrent = prepared('concurrent', { ...scope, generation: 2 });
    await new StorageReferenceRegistry(executor(writer), 'postgres', namespace).replace({
      consumer: 'owner:avatar',
      previousReference: null,
      next: concurrent,
    });
    await writer.query('COMMIT');
    await expect(cleaner.query('COMMIT')).rejects.toMatchObject({ code: '40001' });
    await cleaner.query('ROLLBACK');
    expect((await relocations.listForSubject(scope.subjectId)).receipts).toHaveLength(1);
    expect(
      await references.resolve({ consumer: 'owner:avatar', reference: concurrent.reference }),
    ).toMatchObject({ prepared: concurrent });
    expect(
      await new StorageWriteJournal(cleanerExecutor, 'postgres', namespace).tombstone(scope.subjectId),
    ).toBeNull();
  });

  it('rejects a new reference after the owning scope is tombstoned', async () => {
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
    const backend = prepareStorageBackend(namespace, {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
      publicUrl: 'https://media.example',
    });
    const scope = { subjectId: `profile:${randomUUID()}`, generation: 1 };
    const next = prepareStorageReference({
      namespace,
      operationId: randomUUID(),
      reference: 'https://media.example/new',
      target: { backendId: backend.id, binding: backend.binding, key: 'new' },
      scopes: [scope],
    });
    const previous = prepareStorageReference({
      ...next,
      operationId: randomUUID(),
      reference: 'https://media.example/previous',
      target: { ...next.target, key: 'previous' },
    });
    await cleaner.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await new StorageBackendRegistry(executor(cleaner), 'postgres', namespace).register(backend);
    await new StorageReferenceRegistry(executor(cleaner), 'postgres', namespace).replace({
      consumer: 'late:avatar',
      previousReference: null,
      next: previous,
    });
    const job = prepareStorageCleanup({ namespace, ...scope, retentionPolicy: 'job-id-snapshots-v1' });
    await new StorageCleanupJournal(executor(cleaner), 'postgres', namespace).createJob(job);
    await cleaner.query('COMMIT');
    await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const references = new StorageReferenceRegistry(executor(writer), 'postgres', namespace);
    await expect(
      references.replace({ consumer: 'late:avatar', previousReference: null, next }),
    ).rejects.toThrow('scope is being erased');
    await writer.query('ROLLBACK');
    expect(await references.readReference(next.reference)).toBeNull();
    const other = prepareStorageReference({
      ...next,
      operationId: randomUUID(),
      reference: 'https://media.example/other',
      target: { ...next.target, key: 'other' },
      scopes: [{ subjectId: 'profile:other', generation: 1 }],
    });
    await writer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await expect(
      references.replace({ consumer: 'late:avatar', previousReference: previous.reference, next: other }),
    ).rejects.toThrow('Previous storage scope is being erased');
    await writer.query('ROLLBACK');
    expect(await references.readReference(other.reference)).toBeNull();
  });
});
