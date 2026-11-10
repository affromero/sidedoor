import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  StorageRelocationRegistry,
  storageRelocationSuccessorKey,
} from '../../../../src/storage/local/relocation';
import {
  prepareStorageBackend,
  StorageBackendRegistry,
} from '../../../../src/storage/registry/backend-registry';
import {
  prepareStorageReference,
  StorageReferenceRegistry,
} from '../../../../src/storage/registry/reference-registry';
import { storageBackendBinding } from '../../../../src/storage/registry/references';

const suite = process.env.SIDEDOOR_TEST_DATABASE_URL ? describe : describe.skip;
suite('backward relocation lineage with PostgreSQL', () => {
  it('reads an unchanged multihop history in a Serializable snapshot', async () => {
    const client = new Client({ connectionString: process.env.SIDEDOOR_TEST_DATABASE_URL });
    const schema = `backward_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(
        `CREATE TABLE "${schema}"."SidedoorState" (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state JSONB NOT NULL)`,
      );
      await client.query(`CREATE INDEX ON "${schema}"."SidedoorState" (id text_pattern_ops)`);
      await client.query(`SET search_path TO "${schema}"`);
      const executor = {
        async query(sql: string, values: readonly unknown[]) {
          return (await client.query(sql, [...values])).rows;
        },
      };
      const namespace = 'test';
      const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: randomUUID() };
      const backend = prepareStorageBackend(namespace, {
        kind: 'object',
        location,
        binding: storageBackendBinding(location),
        publicUrl: 'https://media.example',
      });
      const references = new StorageReferenceRegistry(executor, 'postgres', namespace);
      const relocations = new StorageRelocationRegistry(executor, 'postgres', namespace);
      const prepared = (key: string) =>
        prepareStorageReference({
          namespace,
          operationId: randomUUID(),
          reference: `https://media.example/${key}`,
          target: { backendId: backend.id, binding: backend.binding, key },
          scopes: [{ subjectId: 'profile:owner', generation: 1 }],
        });
      const source = prepared('source');
      const first = prepared('first');
      const second = prepared('second');
      const content = { sha256: createHash('sha256').update('verified copy').digest('hex'), bytes: 13 };
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await new StorageBackendRegistry(executor, 'postgres', namespace).register(backend);
      await references.replace({ consumer: 'owner:avatar', previousReference: null, next: source });
      const sourceAsset = await references.readReference(source.reference);
      if (!sourceAsset) throw new Error('Missing source asset');
      await references.replace({
        consumer: 'owner:avatar',
        previousReference: source.reference,
        next: first,
      });
      const firstAsset = await references.readReference(first.reference);
      if (!firstAsset) throw new Error('Missing first asset');
      await relocations.record({
        operationId: first.operationId,
        sourceAssetId: sourceAsset.asset.id,
        destinationAssetId: firstAsset.asset.id,
        consumers: ['owner:avatar'],
        sourceRead: { assetId: sourceAsset.asset.id, ...content },
        destinationRead: { assetId: firstAsset.asset.id, ...content },
      });
      await references.replace({
        consumer: 'owner:avatar',
        previousReference: first.reference,
        next: second,
      });
      const secondAsset = await references.readReference(second.reference);
      if (!secondAsset) throw new Error('Missing second asset');
      await relocations.record({
        operationId: second.operationId,
        sourceAssetId: firstAsset.asset.id,
        destinationAssetId: secondAsset.asset.id,
        consumers: ['owner:avatar'],
        sourceRead: { assetId: firstAsset.asset.id, ...content },
        destinationRead: { assetId: secondAsset.asset.id, ...content },
      });
      await client.query('COMMIT');
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const before = (await client.query('SELECT id, revision, state FROM "SidedoorState" ORDER BY id')).rows;
      const traced = await relocations.traceBackward({
        consumer: 'owner:avatar',
        currentReference: second.reference,
        maxHops: 2,
      });
      expect(traced.edges.map((edge) => edge.operationId)).toEqual([first.operationId, second.operationId]);
      expect(traced.boundary).toEqual({
        kind: 'allocation-origin',
        assetId: sourceAsset.asset.id,
        reference: source.reference,
      });
      expect((await relocations.listSuccessorKeys()).successors).toEqual(
        expect.arrayContaining([
          {
            key: storageRelocationSuccessorKey(sourceAsset.asset.id, 'owner:avatar'),
            operationId: first.operationId,
          },
          {
            key: storageRelocationSuccessorKey(firstAsset.asset.id, 'owner:avatar'),
            operationId: second.operationId,
          },
        ]),
      );
      await expect(relocations.verifySuccessorInventory({ maxEntries: 2 })).resolves.toBeUndefined();
      expect(
        (await client.query('SELECT id, revision, state FROM "SidedoorState" ORDER BY id')).rows,
      ).toEqual(before);
      const namespaceKey = createHash('sha256').update(namespace).digest('hex');
      const template = (await relocations.listAll()).receipts[0];
      if (!template) throw new Error('Missing receipt template');
      for (let index = 0; index < 99; index++) {
        const operationId = randomUUID();
        const consumer = `owner:extra-${index}`;
        const receipt = { ...template, operationId, consumers: [consumer] };
        await client.query('INSERT INTO "SidedoorState" (id, revision, state) VALUES ($1, $2, $3::jsonb)', [
          `sd-rel:1:${namespaceKey}:${operationId}`,
          randomUUID(),
          JSON.stringify(receipt),
        ]);
        await client.query('INSERT INTO "SidedoorState" (id, revision, state) VALUES ($1, $2, $3::jsonb)', [
          `sd-rels:1:${namespaceKey}:${storageRelocationSuccessorKey(receipt.sourceAssetId, consumer)}`,
          randomUUID(),
          JSON.stringify({ operationId }),
        ]);
      }
      const firstPage = await relocations.listSuccessorKeys();
      expect(firstPage.successors).toHaveLength(100);
      const secondPage = await relocations.listSuccessorKeys(firstPage.cursor);
      expect(secondPage.successors).toHaveLength(1);
      expect(secondPage.cursor).toBeNull();
      await expect(relocations.verifySuccessorInventory({ maxEntries: 101 })).resolves.toBeUndefined();
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  }, 30_000);
});
