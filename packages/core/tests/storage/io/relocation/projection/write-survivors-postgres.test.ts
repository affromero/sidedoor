import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { StorageCleanupJournal } from '../../../../../src/storage/cleanup/cleanup-journal';
import { prepareStorageCleanup } from '../../../../../src/storage/cleanup/cleanup-state';
import { StorageRelocationRegistry } from '../../../../../src/storage/local/relocation';
import { writeSurvivorProjection } from '../../../../../src/storage/local/relocation/projection/write-survivors';
import {
  prepareStorageBackend,
  StorageBackendRegistry,
} from '../../../../../src/storage/registry/backend-registry';
import {
  prepareStorageReference,
  StorageReferenceRegistry,
} from '../../../../../src/storage/registry/reference-registry';
import { storageBackendBinding } from '../../../../../src/storage/registry/references';

const suite = process.env.SIDEDOOR_TEST_DATABASE_URL ? describe : describe.skip;
suite('survivor graph persistence with PostgreSQL', () => {
  it('preserves a shared two-hop relocation for the surviving owner', async () => {
    const client = new Client({ connectionString: process.env.SIDEDOOR_TEST_DATABASE_URL });
    const schema = `projection_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(
        `CREATE TABLE "${schema}"."SidedoorState" (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state JSONB NOT NULL)`,
      );
      await client.query(`CREATE INDEX ON "${schema}"."SidedoorState" (id text_pattern_ops)`);
      await client.query(`SET search_path TO "${schema}"`);
      const database = {
        async query(sql: string, values: readonly unknown[]) {
          return (await client.query(sql, [...values])).rows;
        },
      };
      const namespace = 'test';
      const consumers = ['owner:avatar', 'other:avatar'];
      const scopes = [
        { subjectId: 'profile:owner', generation: 1 },
        { subjectId: 'profile:other', generation: 2 },
      ];
      const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
      const backend = prepareStorageBackend(namespace, {
        kind: 'object',
        location,
        binding: storageBackendBinding(location),
        publicUrl: 'https://media.example',
      });
      const references = new StorageReferenceRegistry(database, 'postgres', namespace);
      const relocations = new StorageRelocationRegistry(database, 'postgres', namespace);
      const prepared = (key: string) =>
        prepareStorageReference({
          namespace,
          operationId: randomUUID(),
          reference: `https://media.example/${key}`,
          target: { backendId: backend.id, binding: backend.binding, key },
          scopes,
        });
      const source = prepared('source');
      const middle = prepared('middle');
      const terminal = prepared('terminal');
      const content = { sha256: createHash('sha256').update('verified copy').digest('hex'), bytes: 13 };
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await new StorageBackendRegistry(database, 'postgres', namespace).register(backend);
      await references.replaceMany({
        next: source,
        consumers: consumers.map((consumer) => ({ consumer, previousReference: null })),
      });
      const first = await references.readReference(source.reference);
      if (!first) throw new Error('Missing source asset');
      await references.replaceMany({
        next: middle,
        consumers: consumers.map((consumer) => ({ consumer, previousReference: source.reference })),
      });
      const second = await references.readReference(middle.reference);
      if (!second) throw new Error('Missing middle asset');
      await relocations.record({
        operationId: middle.operationId,
        sourceAssetId: first.asset.id,
        destinationAssetId: second.asset.id,
        consumers,
        sourceRead: { assetId: first.asset.id, ...content },
        destinationRead: { assetId: second.asset.id, ...content },
      });
      await references.replaceMany({
        next: terminal,
        consumers: consumers.map((consumer) => ({ consumer, previousReference: middle.reference })),
      });
      const third = await references.readReference(terminal.reference);
      if (!third) throw new Error('Missing terminal asset');
      await relocations.record({
        operationId: terminal.operationId,
        sourceAssetId: second.asset.id,
        destinationAssetId: third.asset.id,
        consumers,
        sourceRead: { assetId: second.asset.id, ...content },
        destinationRead: { assetId: third.asset.id, ...content },
      });
      const receipts = (await relocations.listAll()).receipts;
      const graph = {
        namespace,
        assets: (await references.listAssets()).assets,
        allocations: (await references.listAllocations()).allocations,
        retirements: (await references.listRetirements()).retirements,
        receipts,
        successors: receipts.flatMap((receipt) =>
          receipt.consumers.map((consumer) => ({
            sourceAssetId: receipt.sourceAssetId,
            operationId: receipt.operationId,
            consumer,
          })),
        ),
        paths: consumers.map((consumer) => ({
          consumer,
          originalAssetId: first.asset.id,
          terminal: { kind: 'live' as const, assetId: third.asset.id },
          maxHops: 2,
        })),
      };
      const job = prepareStorageCleanup({
        namespace,
        subjectId: 'profile:other',
        generation: 2,
        retentionPolicy: 'job-id-snapshots-v1',
      });
      await new StorageCleanupJournal(database, 'postgres', namespace).createJob(job);
      await client.query('COMMIT');
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await writeSurvivorProjection({
        database,
        dialect: 'postgres',
        projection: {
          graph,
          removals: graph.assets.map((asset) => ({
            assetId: asset.id,
            consumers: ['other:avatar'],
            scopes: [scopes[1]!],
          })),
          retirementRemovals: graph.retirements
            .filter((item) => item.consumer === 'other:avatar')
            .map(({ operationId, consumer }) => ({ operationId, consumer })),
          requirements: graph.assets.map((asset) => ({
            assetId: asset.id,
            consumer: 'owner:avatar',
            scopes: [scopes[0]!],
          })),
        },
        authorities: [
          { subjectId: job.subjectId, generation: job.generation, jobId: job.id, epoch: job.epoch },
        ],
        verifyApplication: async () => true,
      });
      await client.query('COMMIT');
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(
        relocations.resolve({
          consumer: 'owner:avatar',
          originalReference: source.reference,
          currentReference: terminal.reference,
          maxHops: 2,
        }),
      ).resolves.toMatchObject({ current: { assetId: third.asset.id }, content });
      expect((await relocations.listForSubject('profile:other')).receipts).toEqual([]);
      expect((await relocations.listForSubject('profile:owner')).receipts).toHaveLength(2);
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  }, 30_000);
});
