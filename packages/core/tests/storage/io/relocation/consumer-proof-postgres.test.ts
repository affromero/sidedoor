import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StorageRelocationRegistry as LegacyRelocationRegistry } from 'thesidedoor-core-legacy/storage';
import {
  StorageRelocationRegistry,
  type StorageRelocationInput,
} from '../../../../src/storage/local/relocation';
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

const suite = process.env.SIDEDOOR_TEST_DATABASE_URL ? describe : describe.skip;
suite('consumer proof with concurrent PostgreSQL transactions', () => {
  const schema = `consumer_proof_${randomUUID().replaceAll('-', '')}`;
  const namespace = 'test';
  let admin: Client;
  let first: Client;
  let second: Client;
  const execute = (client: Client) => ({
    async query(sql: string, values: readonly unknown[]) {
      return (await client.query(sql, [...values])).rows;
    },
  });
  beforeAll(async () => {
    const connectionString = process.env.SIDEDOOR_TEST_DATABASE_URL;
    admin = new Client({ connectionString });
    first = new Client({ connectionString });
    second = new Client({ connectionString });
    await Promise.all([admin.connect(), first.connect(), second.connect()]);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(
      `CREATE TABLE "${schema}"."SidedoorState" (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state JSONB NOT NULL)`,
    );
    await admin.query(`CREATE INDEX ON "${schema}"."SidedoorState" (id text_pattern_ops)`);
    await Promise.all([
      first.query(`SET search_path TO "${schema}"`),
      second.query(`SET search_path TO "${schema}"`),
    ]);
  });
  beforeEach(async () => {
    await first.query('TRUNCATE "SidedoorState"');
  });
  afterAll(async () => {
    await Promise.allSettled([first?.query('ROLLBACK'), second?.query('ROLLBACK')]);
    if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await Promise.allSettled([admin?.end(), first?.end(), second?.end()]);
  });
  async function copiedAsset() {
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
    const backend = prepareStorageBackend(namespace, {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
      publicUrl: 'https://media.example',
    });
    const registry = new StorageReferenceRegistry(execute(first), 'postgres', namespace);
    const consumers = ['owner:avatar', 'other:avatar'];
    const scopes = [{ subjectId: 'profile:owner', generation: 1 }];
    const prepared = (key: string) =>
      prepareStorageReference({
        namespace,
        operationId: randomUUID(),
        reference: `https://media.example/${key}`,
        target: { backendId: backend.id, binding: backend.binding, key },
        scopes,
      });
    const source = prepared('source');
    const destination = prepared('destination');
    await first.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await new StorageBackendRegistry(execute(first), 'postgres', namespace).register(backend);
    await registry.replaceMany({
      next: source,
      consumers: consumers.map((consumer) => ({ consumer, previousReference: null })),
    });
    const sourceAsset = await registry.readReference(source.reference);
    await registry.replaceMany({
      next: destination,
      consumers: consumers.map((consumer) => ({ consumer, previousReference: source.reference })),
    });
    const destinationAsset = await registry.readReference(destination.reference);
    if (!sourceAsset || !destinationAsset) throw new Error('Missing copied assets');
    const content = { sha256: createHash('sha256').update('same bytes').digest('hex'), bytes: 10 };
    const evidence: StorageRelocationInput = {
      operationId: destination.operationId,
      sourceAssetId: sourceAsset.asset.id,
      destinationAssetId: destinationAsset.asset.id,
      consumers,
      sourceRead: { assetId: sourceAsset.asset.id, ...content },
      destinationRead: { assetId: destinationAsset.asset.id, ...content },
    };
    await new StorageRelocationRegistry(execute(first), 'postgres', namespace).record(evidence);
    await first.query('COMMIT');
    return { evidence, content, consumers };
  }
  it('retries concurrent proof creation without losing either consumer', async () => {
    const { evidence, content, consumers } = await copiedAsset();
    const left = new StorageRelocationRegistry(execute(first), 'postgres', namespace);
    const right = new StorageRelocationRegistry(execute(second), 'postgres', namespace);
    await Promise.all([
      first.query('BEGIN ISOLATION LEVEL SERIALIZABLE'),
      second.query('BEGIN ISOLATION LEVEL SERIALIZABLE'),
    ]);
    await Promise.all([left.verifyExisting(evidence), right.verifyExisting(evidence)]);
    await left.createConsumerProof({ operationId: evidence.operationId, consumer: consumers[0]!, content });
    await first.query('COMMIT');
    await expect(
      right.createConsumerProof({ operationId: evidence.operationId, consumer: consumers[1]!, content }),
    ).rejects.toMatchObject({ code: '40001' });
    await second.query('ROLLBACK');
    await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await right.createConsumerProof({ operationId: evidence.operationId, consumer: consumers[1]!, content });
    await second.query('COMMIT');
    for (const consumer of consumers)
      await expect(
        right.verifyConsumerProof({
          operationId: evidence.operationId,
          consumer,
          sourceAssetId: evidence.sourceAssetId,
          destinationAssetId: evidence.destinationAssetId,
          content,
        }),
      ).resolves.toBeUndefined();
  });
  it('does not leave a proof when cleanup commits after the creator read the receipt', async () => {
    const { evidence, content } = await copiedAsset();
    const writer = new StorageRelocationRegistry(execute(first), 'postgres', namespace);
    const cleaner = new StorageRelocationRegistry(execute(second), 'postgres', namespace);
    await first.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await writer.verifyExisting(evidence);
    await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const job = prepareStorageCleanup({
      namespace,
      subjectId: 'profile:owner',
      generation: 1,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await new StorageCleanupJournal(execute(second), 'postgres', namespace).createJob(job);
    await cleaner.eraseForSubject({
      subjectId: job.subjectId,
      generation: job.generation,
      jobId: job.id,
      epoch: job.epoch,
    });
    await second.query('COMMIT');
    await expect(
      writer.createConsumerProof({ operationId: evidence.operationId, consumer: 'owner:avatar', content }),
    ).rejects.toMatchObject({ code: '40001' });
    await first.query('ROLLBACK');
    const proofRows = await second.query(
      'SELECT id FROM "SidedoorState" WHERE id LIKE \'sd-rel-consumer:2:%\'',
    );
    expect(proofRows.rows).toEqual([]);
    expect((await cleaner.listForSubject('profile:owner')).receipts).toEqual([]);
  });
  it('retries cleanup when a proof is committed after cleanup read the old receipt', async () => {
    const { evidence, content } = await copiedAsset();
    const writer = new StorageRelocationRegistry(execute(first), 'postgres', namespace);
    const cleaner = new StorageRelocationRegistry(execute(second), 'postgres', namespace);
    const oldCleaner = new LegacyRelocationRegistry(execute(second), 'postgres', namespace);
    await first.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await writer.verifyExisting(evidence);
    await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const job = prepareStorageCleanup({
      namespace,
      subjectId: 'profile:owner',
      generation: 1,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    const cleanup = new StorageCleanupJournal(execute(second), 'postgres', namespace);
    await cleanup.createJob(job);
    expect((await oldCleaner.listForSubject(job.subjectId)).receipts).toHaveLength(1);
    await writer.createConsumerProof({
      operationId: evidence.operationId,
      consumer: 'owner:avatar',
      content,
    });
    await first.query('COMMIT');
    const request = { subjectId: job.subjectId, generation: job.generation, jobId: job.id, epoch: job.epoch };
    await expect(oldCleaner.eraseForSubject(request)).rejects.toMatchObject({ code: '40001' });
    await second.query('ROLLBACK');
    await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await cleanup.createJob(job);
    await expect(oldCleaner.eraseForSubject(request)).rejects.toThrow();
    await second.query('ROLLBACK');
    await second.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await cleanup.createJob(job);
    await expect(cleaner.eraseForSubject(request)).resolves.toMatchObject({ erased: 1 });
    await second.query('COMMIT');
    const proofRows = await second.query(
      'SELECT id FROM "SidedoorState" WHERE id LIKE \'sd-rel-consumer:2:%\'',
    );
    expect(proofRows.rows).toEqual([]);
  });
});
