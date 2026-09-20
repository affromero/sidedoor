import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  StorageReferenceRegistry,
  StorageReferenceConsumerMismatchError,
  prepareStorageReference,
} from '../src/storage/reference-registry';
import { StorageBackendRegistry, prepareStorageBackend } from '../src/storage/backend-registry';
import { storageBackendBinding } from '../src/storage/references';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function fixture() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      return database.prepare(sql).all(...(values as SQLInputValue[]));
    },
  };
  const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };
  const backend = prepareStorageBackend('app', {
    kind: 'object',
    location,
    binding: storageBackendBinding(location),
    publicUrl: 'https://media.example',
  });
  await new StorageBackendRegistry(executor, 'sqlite', 'app').register(backend);
  const registry = new StorageReferenceRegistry(executor, 'sqlite', 'app');
  const prepare = () => {
    const operationId = randomUUID();
    return prepareStorageReference({
      namespace: 'app',
      operationId,
      reference: `https://media.example/${operationId}.png`,
      target: { backendId: backend.id, binding: backend.binding, key: `${operationId}.png` },
      scopes: [{ subjectId: 'profile:owner', generation: 1 }],
    });
  };
  async function transaction(operation: () => Promise<void>) {
    database.exec('BEGIN');
    try {
      await operation();
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  function records(kind: string): unknown[] {
    return database
      .prepare("SELECT state FROM SidedoorState WHERE json_extract(state, '$.kind') = ? ORDER BY id")
      .all(kind)
      .map((row) => JSON.parse(String(row.state)));
  }
  return { database, registry, prepare, transaction, records };
}

describe('durable storage reference attribution', () => {
  it('retains exact transfer evidence after the source loses its consumer', async () => {
    const { registry, prepare, transaction } = await fixture();
    const source = prepare();
    const destination = prepare();
    await transaction(() =>
      registry.replace({ consumer: 'owner:avatar', previousReference: null, next: source }),
    );
    const original = await registry.resolve({ consumer: 'owner:avatar', reference: source.reference });
    await transaction(() =>
      registry.replace({ consumer: 'owner:avatar', previousReference: source.reference, next: destination }),
    );
    const current = await registry.resolve({ consumer: 'owner:avatar', reference: destination.reference });
    const retained = await registry.readAsset(original!.assetId);
    expect(retained?.asset).toMatchObject({ prepared: source, consumers: [] });
    expect(await registry.readAllocation(current!.assetId)).toMatchObject({
      operationId: destination.operationId,
      claims: [{ consumer: 'owner:avatar', previousReference: source.reference }],
    });
    expect(await registry.readRetirement(destination.operationId, 'owner:avatar')).toMatchObject({
      attribution: { assetId: original!.assetId, prepared: source },
      replacementAssetId: current!.assetId,
      status: 'pending',
    });
    retained!.asset.prepared.target.key = 'changed';
    expect((await registry.readAsset(original!.assetId))?.asset.prepared).toEqual(source);
    expect(await registry.readRetirement(randomUUID(), 'owner:avatar')).toBeNull();
  });
  it('resolves exact consumer attribution and returns detached backend data', async () => {
    const { registry, prepare, transaction } = await fixture();
    const next = prepare();
    await transaction(() => registry.replace({ consumer: 'segment:audio', previousReference: null, next }));
    const resolved = await registry.resolve({ consumer: 'segment:audio', reference: next.reference });
    expect(resolved).toMatchObject({
      prepared: next,
      backend: { id: next.target.backendId, binding: next.target.binding },
    });
    expect(resolved?.backend.descriptor).toMatchObject({ location: { bucket: 'private' } });
    resolved!.prepared.target.key = 'mutated';
    expect(
      (await registry.resolve({ consumer: 'segment:audio', reference: next.reference }))?.prepared,
    ).toEqual(next);
    await expect(
      registry.resolve({ consumer: 'unrelated', reference: next.reference }),
    ).rejects.toBeInstanceOf(StorageReferenceConsumerMismatchError);
    expect(
      await registry.resolve({ consumer: 'segment:audio', reference: 'unattributed/audio.mp3' }),
    ).toBeNull();
  });

  it('keeps historical attribution available only to its remaining version consumer', async () => {
    const { registry, prepare, transaction } = await fixture();
    const next = prepare();
    await transaction(() =>
      registry.replaceMany({
        next,
        consumers: [
          { consumer: 'episode:audio', previousReference: null },
          { consumer: 'version:audio', previousReference: null },
        ],
      }),
    );
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'episode:audio',
        previousReference: next.reference,
      }),
    );
    await expect(registry.resolve({ consumer: 'episode:audio', reference: next.reference })).rejects.toThrow(
      'does not belong',
    );
    expect(
      (await registry.resolve({ consumer: 'version:audio', reference: next.reference }))?.prepared,
    ).toEqual(next);
  });

  it.each(['backend', 'asset'])(
    'rejects a missing %s instead of treating a broken reference as unattributed',
    async (missing) => {
      const { database, registry, prepare, transaction } = await fixture();
      const next = prepare();
      await transaction(() => registry.replace({ consumer: 'segment:audio', previousReference: null, next }));
      database
        .prepare('DELETE FROM SidedoorState WHERE id LIKE ?')
        .run(missing === 'backend' ? 'sd-b:1:%' : 'sd-asset:1:%');
      await expect(
        registry.resolve({ consumer: 'segment:audio', reference: next.reference }),
      ).rejects.toThrow(missing === 'backend' ? 'backend is missing' : 'attribution is missing');
      await expect(
        registry.resolve({ consumer: 'unrelated', reference: next.reference }),
      ).rejects.not.toBeInstanceOf(StorageReferenceConsumerMismatchError);
    },
  );

  it.each(['null-to-reference', 'reference-to-reference', 'reference-to-null'])(
    'rejects changed replay claims: %s',
    async (change) => {
      const { registry, prepare, transaction, records } = await fixture();
      const previous = prepare();
      await transaction(() =>
        registry.replace({ consumer: 'current', previousReference: null, next: previous }),
      );
      const next = prepare();
      const original = change === 'null-to-reference' ? null : previous.reference;
      await transaction(() =>
        registry.replaceMany({ next, consumers: [{ consumer: 'current', previousReference: original }] }),
      );
      const beforeAssets = records('storage_asset');
      const beforeRetirements = records('storage_reference_retirement');
      const changed =
        change === 'reference-to-null'
          ? null
          : change === 'null-to-reference'
            ? previous.reference
            : 'https://media.example/unrelated.png';
      await expect(
        transaction(() =>
          registry.replaceMany({ next, consumers: [{ consumer: 'current', previousReference: changed }] }),
        ),
      ).rejects.toThrow('claims changed');
      expect(records('storage_asset')).toEqual(beforeAssets);
      expect(records('storage_reference_retirement')).toEqual(beforeRetirements);
    },
  );
  it('retains historical consumers when replacing the current audio with another version', async () => {
    const { registry, prepare, transaction } = await fixture();
    const first = prepare();
    await transaction(() =>
      registry.replaceMany({
        next: first,
        consumers: [
          { consumer: 'episode:audio', previousReference: null },
          { consumer: 'version:1:audio', previousReference: null },
        ],
      }),
    );
    const next = prepare();
    const replacement = {
      next,
      consumers: [
        { consumer: 'episode:audio', previousReference: first.reference },
        { consumer: 'version:2:audio', previousReference: null },
      ],
    };
    await transaction(() => registry.replaceMany(replacement));
    await transaction(() =>
      registry.replaceMany({ ...replacement, consumers: [...replacement.consumers].reverse() }),
    );
    const assets = (await registry.listAssets()).assets;
    expect(assets.find((asset) => asset.prepared.reference === first.reference)?.consumers).toEqual([
      'version:1:audio',
    ]);
    expect(assets.find((asset) => asset.prepared.reference === next.reference)?.consumers).toEqual([
      'episode:audio',
      'version:2:audio',
    ]);
    expect((await registry.listRetirements()).retirements).toHaveLength(1);
  });
  it('rejects duplicate or excessive consumers before allocating an asset', async () => {
    const { registry, prepare } = await fixture();
    const consumer = { consumer: 'episode:audio', previousReference: null };
    await expect(registry.replaceMany({ next: prepare(), consumers: [consumer, consumer] })).rejects.toThrow(
      'distinct',
    );
    await expect(
      registry.replaceMany({
        next: prepare(),
        consumers: Array.from({ length: 101 }, (_, i) => ({
          consumer: `version:${i}`,
          previousReference: null,
        })),
      }),
    ).rejects.toThrow();
    expect((await registry.listAssets()).assets).toEqual([]);
  });
  it('rolls back all replacements if a later retirement cannot be persisted', async () => {
    const { registry, prepare, transaction, database } = await fixture();
    const first = prepare();
    await transaction(() =>
      registry.replaceMany({
        next: first,
        consumers: [
          { consumer: 'first', previousReference: null },
          { consumer: 'second', previousReference: null },
        ],
      }),
    );
    database.exec(
      `CREATE TRIGGER reject_second BEFORE INSERT ON SidedoorState WHEN json_extract(NEW.state, '$.kind') = 'storage_reference_retirement' AND json_extract(NEW.state, '$.consumer') = 'second' BEGIN SELECT RAISE(ABORT, 'Rejected second retirement'); END`,
    );
    await expect(
      transaction(() =>
        registry.replaceMany({
          next: prepare(),
          consumers: [
            { consumer: 'first', previousReference: first.reference },
            { consumer: 'second', previousReference: first.reference },
          ],
        }),
      ),
    ).rejects.toThrow('Rejected second retirement');
    expect((await registry.listAssets()).assets).toMatchObject([
      { prepared: first, consumers: ['first', 'second'] },
    ]);
    expect((await registry.listRetirements()).retirements).toEqual([]);
  });
  it('discovers every live and retired asset through bounded pages without losing another scope', async () => {
    const { registry, prepare, transaction } = await fixture();
    const references = Array.from({ length: 205 }, () => prepare());
    await transaction(async () => {
      for (const [index, next] of references.entries()) {
        next.scopes = [{ subjectId: `profile:${index % 2}`, generation: 1 }];
        await registry.replace({ consumer: `profile:${index}:avatar`, previousReference: null, next });
      }
      await registry.retire({
        operationId: randomUUID(),
        consumer: 'profile:0:avatar',
        previousReference: references[0]!.reference,
      });
    });
    const first = await registry.listAssets();
    expect(first.assets).toHaveLength(100);
    expect(first.cursor).not.toBeNull();
    const second = await registry.listAssets(first.cursor);
    expect(second.assets).toHaveLength(100);
    expect(second.cursor).not.toBeNull();
    const third = await registry.listAssets(second.cursor);
    expect(third.assets).toHaveLength(5);
    expect(third.cursor).toBeNull();
    const all = [...first.assets, ...second.assets, ...third.assets];
    expect(new Set(all.map((asset) => asset.prepared.reference))).toEqual(
      new Set(references.map((ref) => ref.reference)),
    );
    expect(all.find((asset) => asset.prepared.reference === references[0]!.reference)?.consumers).toEqual([]);
    await expect(registry.listRetirements(first.cursor)).rejects.toThrow(
      'cursor belongs to another namespace',
    );
  });
  it('discovers unresolved retirements that have no allocated asset', async () => {
    const { registry, transaction } = await fixture();
    const removals = Array.from({ length: 101 }, (_, index) => ({
      operationId: randomUUID(),
      consumer: `profile:${index}:avatar`,
      previousReference: `https://old.example/${index}.png`,
    }));
    await transaction(async () => {
      for (const removal of removals) await registry.retire(removal);
    });
    expect((await registry.listAssets()).assets).toEqual([]);
    const first = await registry.listRetirements();
    expect(first.retirements).toHaveLength(100);
    expect(first.cursor).not.toBeNull();
    const last = await registry.listRetirements(first.cursor);
    expect(last.retirements).toHaveLength(1);
    expect(last.cursor).toBeNull();
    expect(
      new Set([...first.retirements, ...last.retirements].map((record) => record.previousReference)),
    ).toEqual(new Set(removals.map((removal) => removal.previousReference)));
  });
  it('rejects malformed stored ownership rather than silently skipping it during enumeration', async () => {
    const { database, registry, prepare, transaction } = await fixture();
    await transaction(() =>
      registry.replace({ consumer: 'owner:avatar', previousReference: null, next: prepare() }),
    );
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.prepared.target.key', 'changed.png') WHERE json_extract(state, '$.kind') = 'storage_asset'",
      )
      .run();
    await expect(registry.listAssets()).rejects.toThrow('Storage asset identity mismatch');
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: 'https://old.example/avatar.png',
      }),
    );
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.namespace', 'foreign') WHERE json_extract(state, '$.kind') = 'storage_reference_retirement'",
      )
      .run();
    await expect(registry.listRetirements()).rejects.toThrow('Storage retirement identity mismatch');
  });
  it('retains exact attribution when a reference is removed without a replacement asset', async () => {
    const { registry, prepare, transaction, records } = await fixture();
    const first = prepare();
    await transaction(() =>
      registry.replace({ consumer: 'owner:avatar', previousReference: null, next: first }),
    );
    const removal = {
      operationId: randomUUID(),
      consumer: 'owner:avatar',
      previousReference: first.reference,
    };
    await transaction(() => registry.retire(removal));
    const snapshot = records('storage_reference_retirement');
    expect(snapshot).toEqual([
      expect.objectContaining({
        ...removal,
        replacementAssetId: null,
        attribution: expect.objectContaining({ prepared: first }),
        status: 'pending',
      }),
    ]);
    expect(records('storage_asset')).toEqual([expect.objectContaining({ prepared: first, consumers: [] })]);
    await transaction(() => registry.retire(removal));
    expect(records('storage_reference_retirement')).toEqual(snapshot);
    await expect(
      transaction(() =>
        registry.retire({
          ...removal,
          previousReference: 'https://other.example/avatar.png',
        }),
      ),
    ).rejects.toThrow('Storage retirement identity mismatch');
    expect(records('storage_reference_retirement')).toEqual(snapshot);
  });
  it('rolls back reference removal and retains unresolved attribution on success', async () => {
    const { registry, transaction, records } = await fixture();
    const removal = {
      operationId: randomUUID(),
      consumer: 'owner:avatar',
      previousReference: 'https://old.example/avatar.png',
    };
    await expect(
      transaction(async () => {
        await registry.retire(removal);
        throw new Error('Application removal failed');
      }),
    ).rejects.toThrow('Application removal failed');
    expect(records('storage_reference_retirement')).toEqual([]);
    await transaction(() => registry.retire(removal));
    expect(records('storage_reference_retirement')).toEqual([
      expect.objectContaining({
        ...removal,
        replacementAssetId: null,
        attribution: null,
        status: 'unresolved',
      }),
    ]);
  });
  it('rejects URL attribution to another key or backend before recording ownership', async () => {
    const { registry, prepare, transaction, records } = await fixture();
    const prepared = prepare();
    for (const reference of ['https://media.example/other.png', 'https://foreign.example/file.png']) {
      await expect(
        transaction(() =>
          registry.replace({
            consumer: 'owner:avatar',
            previousReference: null,
            next: { ...prepared, reference },
          }),
        ),
      ).rejects.toThrow();
    }
    expect(records('storage_asset')).toEqual([]);
    expect(records('storage_reference_alias')).toEqual([]);
  });
  it('preserves unknown references without guessing their backend', async () => {
    const { registry, prepare, transaction, records } = await fixture();
    const next = prepare();
    await transaction(() =>
      registry.replace({
        consumer: 'owner:avatar',
        previousReference: 'https://previous.example/outside-layout.png',
        next,
      }),
    );
    expect(records('storage_reference_retirement')).toEqual([
      expect.objectContaining({
        previousReference: 'https://previous.example/outside-layout.png',
        attribution: null,
        status: 'unresolved',
        consumer: 'owner:avatar',
        operationId: next.operationId,
      }),
    ]);
  });
  it('retires known references with exact backend ownership and keeps retries idempotent', async () => {
    const { registry, prepare, transaction, records } = await fixture();
    const first = prepare();
    const next = prepare();
    await transaction(() =>
      registry.replace({ consumer: 'owner:avatar', previousReference: null, next: first }),
    );
    await transaction(() =>
      registry.replace({ consumer: 'owner:avatar', previousReference: first.reference, next }),
    );
    const snapshot = records('storage_reference_retirement');
    expect(snapshot).toEqual([
      expect.objectContaining({
        status: 'pending',
        attribution: expect.objectContaining({ prepared: first }),
      }),
    ]);
    expect(records('storage_asset')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ prepared: first, consumers: [] }),
        expect.objectContaining({ prepared: next, consumers: ['owner:avatar'] }),
      ]),
    );
    await transaction(() =>
      registry.replace({ consumer: 'owner:avatar', previousReference: first.reference, next }),
    );
    expect(records('storage_reference_retirement')).toEqual(snapshot);
  });
  it('keeps another consumer attribution intact when an unowned reference is replaced', async () => {
    const { registry, prepare, transaction, records } = await fixture();
    const other = prepare();
    await transaction(() =>
      registry.replace({ consumer: 'other:avatar', previousReference: null, next: other }),
    );
    await transaction(() =>
      registry.replace({ consumer: 'owner:avatar', previousReference: other.reference, next: prepare() }),
    );
    expect(records('storage_reference_retirement')[0]).toMatchObject({
      attribution: null,
      status: 'unresolved',
    });
    expect(records('storage_asset')).toContainEqual(
      expect.objectContaining({ prepared: other, consumers: ['other:avatar'] }),
    );
  });
  it('rolls back attribution and retirement with a failed application reference transaction', async () => {
    const { registry, prepare, transaction, records } = await fixture();
    const first = prepare();
    await transaction(() =>
      registry.replace({ consumer: 'owner:avatar', previousReference: null, next: first }),
    );
    await expect(
      transaction(async () => {
        await registry.replace({
          consumer: 'owner:avatar',
          previousReference: first.reference,
          next: prepare(),
        });
        throw new Error('Application update failed');
      }),
    ).rejects.toThrow('Application update failed');
    expect(records('storage_reference_retirement')).toEqual([]);
    expect(records('storage_asset')).toHaveLength(1);
    expect(records('storage_asset')[0]).toMatchObject({ consumers: ['owner:avatar'] });
  });
});
