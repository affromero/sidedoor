import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageBackendRegistry, prepareStorageBackend } from '../src/storage/backend-registry';
import { StorageReferenceRegistry, prepareStorageReference } from '../src/storage/reference-registry';
import { StorageRelocationRegistry, type StorageRelocationInput } from '../src/storage/relocation';
import { storageBackendBinding } from '../src/storage/references';
import { StorageWriteJournal, prepareStorageTombstone } from '../src/storage/write-journal';
import { StorageCleanupJournal } from '../src/storage/cleanup-journal';
import { prepareStorageCleanup } from '../src/storage/cleanup-state';
import { StorageCleanupAttribution } from '../src/storage/cleanup-attribution';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function fixture(afterQuery?: (values: readonly unknown[], rows: readonly unknown[]) => void) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(
    'CREATE TABLE SidedoorState (id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL)',
  );
  const executor = {
    async query(sql: string, values: readonly unknown[]) {
      const rows = database.prepare(sql).all(...(values as SQLInputValue[]));
      afterQuery?.(values, rows);
      return rows;
    },
  };
  const registry = new StorageReferenceRegistry(executor, 'sqlite', 'test');
  const relocations = new StorageRelocationRegistry(executor, 'sqlite', 'test');
  const writes = new StorageWriteJournal(executor, 'sqlite', 'test');
  const cleanup = new StorageCleanupJournal(executor, 'sqlite', 'test');
  const classifier = new StorageCleanupAttribution(executor, 'sqlite', 'test');
  async function transaction<Result>(run: () => Promise<Result>) {
    database.exec('BEGIN');
    try {
      const result = await run();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  async function asset(
    consumers = ['owner:avatar'],
    previous: string | null = null,
    scopes = [{ subjectId: 'profile:owner', generation: 1 }],
  ) {
    const operationId = randomUUID();
    const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: operationId };
    const backend = prepareStorageBackend('test', {
      kind: 'object',
      location,
      binding: storageBackendBinding(location),
      publicUrl: `https://media.example/${operationId}`,
    });
    const prepared = prepareStorageReference({
      namespace: 'test',
      operationId,
      reference: `https://media.example/${operationId}/image.png`,
      target: { backendId: backend.id, binding: backend.binding, key: 'image.png' },
      scopes,
    });
    await transaction(async () => {
      await new StorageBackendRegistry(executor, 'sqlite', 'test').register(backend);
      await registry.replaceMany({
        next: prepared,
        consumers: consumers.map((consumer) => ({ consumer, previousReference: previous })),
      });
    });
    const retained = await registry.readReference(prepared.reference);
    return { id: retained!.asset.id, prepared };
  }
  function proof(
    source: Awaited<ReturnType<typeof asset>>,
    destination: Awaited<ReturnType<typeof asset>>,
    consumers = ['owner:avatar'],
  ): StorageRelocationInput {
    const content = { sha256: createHash('sha256').update('verified copy').digest('hex'), bytes: 13 };
    return {
      operationId: destination.prepared.operationId,
      sourceAssetId: source.id,
      destinationAssetId: destination.id,
      consumers,
      sourceRead: { assetId: source.id, ...content },
      destinationRead: { assetId: destination.id, ...content },
    };
  }
  async function pair() {
    const source = await asset();
    const destination = await asset(undefined, source.prepared.reference);
    return { source, destination, evidence: proof(source, destination) };
  }
  async function erasure() {
    const job = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'profile:owner',
      generation: 1,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await transaction(() => cleanup.createJob(job));
    return { subjectId: job.subjectId, generation: job.generation, jobId: job.id, epoch: job.epoch };
  }
  return {
    database,
    registry,
    relocations,
    writes,
    cleanup,
    classifier,
    erasure,
    transaction,
    asset,
    proof,
    pair,
  };
}

describe('explicit storage relocation provenance', () => {
  it('requires the exact copy operation on a chain after further relocations', async () => {
    const { relocations, transaction, asset, proof } = fixture();
    const first = await asset();
    const second = await asset(undefined, first.prepared.reference);
    await transaction(() => relocations.record(proof(first, second)));
    const third = await asset(undefined, second.prepared.reference);
    await transaction(() => relocations.record(proof(second, third)));
    const fourth = await asset(undefined, third.prepared.reference);
    await transaction(() => relocations.record(proof(third, fourth)));
    const input = {
      consumer: 'owner:avatar',
      originalReference: first.prepared.reference,
      currentReference: fourth.prepared.reference,
      maxHops: 10,
    };
    for (const [source, destination] of [
      [first, second],
      [second, third],
    ] as const) {
      const requiredOperation = {
        operationId: destination.prepared.operationId,
        sourceAssetId: source.id,
        destinationAssetId: destination.id,
      };
      expect(await relocations.resolve({ ...input, requiredOperation })).toMatchObject({
        originalAssetId: first.id,
        current: { assetId: fourth.id },
      });
      expect(
        await relocations.resolve({
          ...input,
          requiredOperation: { ...requiredOperation, sourceAssetId: fourth.id },
        }),
      ).toBeNull();
      expect(
        await relocations.resolve({
          ...input,
          requiredOperation: { ...requiredOperation, destinationAssetId: first.id },
        }),
      ).toBeNull();
      expect(
        await relocations.resolve({
          ...input,
          requiredOperation: { ...requiredOperation, operationId: randomUUID() },
        }),
      ).toBeNull();
      expect(
        await relocations.resolve({
          ...input,
          originalReference: fourth.prepared.reference,
          requiredOperation,
        }),
      ).toBeNull();
    }
  });
  it('classifies retained endpoints while keeping live shared consumers unresolved', async () => {
    const { relocations, cleanup, classifier, erasure, transaction, pair } = fixture();
    const { source, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const request = await erasure();
    await transaction(() => relocations.eraseForSubject(request));
    const manifest = (await cleanup.listManifests(request.jobId)).pages[0]!;
    expect(await classifier.inspectPage({ ...request, pageId: manifest.id })).toMatchObject({
      entries: [
        { index: 0, status: 'attributed', target: source.prepared.target },
        { index: 1, status: 'unresolved', reason: 'live_consumers' },
      ],
    });
    expect((await cleanup.get(request.jobId)).unresolvedManifests).toBe(1);
    await expect(classifier.inspectPage({ ...request, pageId: 'not-persisted' })).rejects.toThrow(
      'manifest is missing',
    );
    await expect(classifier.inspectPage({ ...request, generation: 99, pageId: manifest.id })).rejects.toThrow(
      'cleanup authority',
    );
  });
  it('validates captured attribution after asset rows are removed and leaves missing evidence unresolved', async () => {
    const { database, relocations, cleanup, classifier, erasure, transaction, pair } = fixture();
    const { source, destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const request = await erasure();
    await transaction(() => relocations.eraseForSubject(request));
    database.prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-asset:%'").run();
    const manifest = (await cleanup.listManifests(request.jobId)).pages[0]!;
    expect(await classifier.inspectPage({ ...request, pageId: manifest.id })).toMatchObject({
      entries: [
        { index: 0, status: 'attributed', target: source.prepared.target },
        { index: 1, status: 'attributed', target: destination.prepared.target },
      ],
    });
    await transaction(() =>
      cleanup.recordManifestPage(request.jobId, 0, {
        id: 'unresolved',
        entries: [
          { kind: 'write_protocol', version: 1 },
          {
            kind: 'storage_relocation_dependency',
            role: 'source',
            operationId: evidence.operationId,
            assetId: evidence.sourceAssetId,
            scopes: [{ subjectId: request.subjectId, generation: 1 }],
            prepared: null,
          },
        ],
      }),
    );
    expect(await classifier.inspectPage({ ...request, pageId: 'unresolved' })).toEqual({
      pageId: 'unresolved',
      entries: [
        { index: 0, status: 'unresolved', reason: 'unsupported_entry' },
        { index: 1, status: 'unresolved', reason: 'missing_attribution' },
      ],
    });
  });
  it.each(['operation', 'scope', 'key', 'namespace', 'role', 'duplicate_scope'] as const)(
    'rejects malformed retained cleanup %s evidence',
    async (mismatch) => {
      const { cleanup, classifier, erasure, transaction, pair } = fixture();
      const { destination, evidence } = await pair();
      const request = await erasure();
      const prepared = structuredClone(destination.prepared);
      if (mismatch === 'operation') prepared.operationId = randomUUID();
      if (mismatch === 'scope') prepared.scopes = [{ subjectId: 'foreign', generation: 1 }];
      if (mismatch === 'key') prepared.target.key = 'wrong.png';
      if (mismatch === 'namespace') prepared.namespace = 'foreign';
      await transaction(() =>
        cleanup.recordManifestPage(request.jobId, 0, {
          id: 'corrupt',
          entries: [
            {
              kind: 'storage_relocation_dependency',
              role: mismatch === 'role' ? 'invalid' : 'destination',
              operationId: evidence.operationId,
              assetId: evidence.destinationAssetId,
              scopes: Array.from({ length: mismatch === 'duplicate_scope' ? 2 : 1 }, () => ({
                subjectId: request.subjectId,
                generation: 1,
              })),
              prepared,
            },
          ],
        }),
      );
      await expect(classifier.inspectPage({ ...request, pageId: 'corrupt' })).rejects.toThrow();
    },
  );
  it('classifies canonical asset and retirement snapshots using the same attribution rules', async () => {
    const { registry, cleanup, classifier, erasure, transaction, pair } = fixture();
    const { source, destination } = await pair();
    const asset = (await registry.readAsset(source.id))!.asset;
    const retirement = await registry.readRetirement(destination.prepared.operationId, 'owner:avatar');
    const request = await erasure();
    await transaction(() =>
      cleanup.recordManifestPage(request.jobId, 0, { id: 'canonical', entries: [asset, retirement] }),
    );
    expect(await classifier.inspectPage({ ...request, pageId: 'canonical' })).toMatchObject({
      entries: [
        { status: 'attributed', target: source.prepared.target },
        { status: 'attributed', target: source.prepared.target },
      ],
    });
    await transaction(() =>
      cleanup.recordManifestPage(request.jobId, 0, {
        id: 'foreign',
        entries: [{ ...retirement!, namespace: 'foreign' }],
      }),
    );
    await expect(classifier.inspectPage({ ...request, pageId: 'foreign' })).rejects.toThrow('namespace');
    await transaction(() =>
      cleanup.recordManifestPage(request.jobId, 0, {
        id: 'unknown-retirement',
        entries: [{ ...retirement!, attribution: null, status: 'unresolved' }],
      }),
    );
    expect(await classifier.inspectPage({ ...request, pageId: 'unknown-retirement' })).toEqual({
      pageId: 'unknown-retirement',
      entries: [{ index: 0, status: 'unresolved', reason: 'missing_attribution' }],
    });
  });
  it('retains both cleanup targets before erasing every owning scope index', async () => {
    const { relocations, cleanup, erasure, transaction, asset, proof } = fixture();
    const scopes = [
      { subjectId: 'profile:owner', generation: 1 },
      { subjectId: 'profile:historical', generation: 2 },
    ];
    const source = await asset(undefined, null, scopes);
    const destination = await asset(undefined, source.prepared.reference, scopes);
    const evidence = proof(source, destination);
    await transaction(() => relocations.record(evidence));
    const request = await erasure();
    expect(await transaction(() => relocations.eraseForSubject(request))).toEqual({
      erased: 1,
      cursor: null,
    });
    expect((await relocations.listForSubject('profile:owner')).receipts).toEqual([]);
    expect((await relocations.listForSubject('profile:historical')).receipts).toEqual([]);
    const manifests = await cleanup.listManifests(request.jobId);
    expect(manifests.pages.flatMap((page) => page.entries)).toEqual([
      expect.objectContaining({
        role: 'source',
        assetId: source.id,
        prepared: source.prepared,
        scopes: expect.arrayContaining(scopes),
      }),
      expect.objectContaining({
        role: 'destination',
        assetId: destination.id,
        prepared: destination.prepared,
        scopes: expect.arrayContaining(scopes),
      }),
    ]);
    await expect(transaction(() => relocations.record(evidence))).rejects.toThrow('already allocated');
    expect(await transaction(() => relocations.eraseForSubject(request))).toEqual({
      erased: 0,
      cursor: null,
    });
  });
  it('retains unresolved ownership evidence when endpoint metadata is missing', async () => {
    const { database, relocations, cleanup, erasure, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const request = await erasure();
    database.prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-asset:%'").run();
    await transaction(() => relocations.eraseForSubject(request));
    const manifests = await cleanup.listManifests(request.jobId);
    expect(manifests.pages.flatMap((page) => page.entries)).toEqual([
      expect.objectContaining({
        role: 'source',
        prepared: null,
        scopes: [{ subjectId: 'profile:owner', generation: 1 }],
      }),
      expect.objectContaining({
        role: 'destination',
        prepared: null,
        scopes: [{ subjectId: 'profile:owner', generation: 1 }],
      }),
    ]);
    expect(await cleanup.get(request.jobId)).toMatchObject({ phase: 'preparing', unresolvedManifests: 1 });
  });
  it.each(['generation', 'epoch', 'subject', 'tombstone'] as const)(
    'rejects mismatched erasure %s without changing evidence',
    async (mismatch) => {
      const { database, relocations, cleanup, erasure, transaction, pair } = fixture();
      const { evidence } = await pair();
      await transaction(() => relocations.record(evidence));
      const request = await erasure();
      if (mismatch === 'generation') request.generation++;
      if (mismatch === 'epoch') request.epoch++;
      if (mismatch === 'subject') request.subjectId = 'profile:other';
      if (mismatch === 'tombstone')
        database
          .prepare(
            "UPDATE SidedoorState SET state = json_set(state, '$.jobId', ?) WHERE json_extract(state, '$.kind') = 'tombstone'",
          )
          .run(randomUUID());
      await expect(transaction(() => relocations.eraseForSubject(request))).rejects.toThrow(
        'cleanup authority',
      );
      expect((await relocations.listForSubject('profile:owner')).receipts).toHaveLength(1);
      expect((await cleanup.listManifests(request.jobId)).pages).toEqual([]);
    },
  );
  it('preserves a successor owned by another operation', async () => {
    const { database, relocations, erasure, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const replacement = randomUUID();
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.operationId', ?) WHERE id LIKE 'sd-rels:%'",
      )
      .run(replacement);
    const request = await erasure();
    await transaction(() => relocations.eraseForSubject(request));
    const row = database.prepare("SELECT state FROM SidedoorState WHERE id LIKE 'sd-rels:%'").get();
    expect(JSON.parse(String(row?.state))).toEqual({ operationId: replacement });
    await expect(transaction(() => relocations.record(evidence))).rejects.toThrow('already allocated');
  });
  it('rolls back retained manifests and index deletion when receipt deletion fails', async () => {
    const { database, relocations, cleanup, erasure, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const request = await erasure();
    database.exec(
      "CREATE TRIGGER fail_erasure BEFORE DELETE ON SidedoorState WHEN OLD.id LIKE 'sd-rel:1:%' BEGIN SELECT RAISE(ABORT, 'erasure unavailable'); END",
    );
    await expect(transaction(() => relocations.eraseForSubject(request))).rejects.toThrow(
      'erasure unavailable',
    );
    expect((await cleanup.listManifests(request.jobId)).pages).toEqual([]);
    expect((await relocations.listForSubject('profile:owner')).receipts).toHaveLength(1);
    database.exec('DROP TRIGGER fail_erasure');
    expect(await transaction(() => relocations.eraseForSubject(request))).toEqual({
      erased: 1,
      cursor: null,
    });
  });
  it('never reuses an operation after its identifying receipt is removed', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    database.prepare('DELETE FROM SidedoorState WHERE id LIKE ?').run(`sd-rel:1:%:${evidence.operationId}`);
    await expect(transaction(() => relocations.record(evidence))).rejects.toThrow('already allocated');
  });
  it('rejects replay when its allocation evidence is missing or corrupt', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const key = `sd-rel-allocation:1:%:${evidence.operationId}`;
    database.prepare('UPDATE SidedoorState SET state = ? WHERE id LIKE ?').run('{}', key);
    await expect(transaction(() => relocations.record(evidence))).rejects.toThrow();
    database.prepare('DELETE FROM SidedoorState WHERE id LIKE ?').run(key);
    await expect(transaction(() => relocations.record(evidence))).rejects.toThrow(
      'allocation evidence is missing',
    );
  });
  it('rolls back receipt and indexes if operation allocation cannot commit', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const { source, destination, evidence } = await pair();
    database.exec(
      "CREATE TRIGGER fail_allocation BEFORE INSERT ON SidedoorState WHEN NEW.id LIKE 'sd-rel-allocation:%' BEGIN SELECT RAISE(ABORT, 'allocation unavailable'); END",
    );
    await expect(transaction(() => relocations.record(evidence))).rejects.toThrow('allocation unavailable');
    expect(await relocations.listForSubject('profile:owner')).toEqual({ receipts: [], cursor: null });
    expect(
      await relocations.resolve({
        consumer: 'owner:avatar',
        originalReference: source.prepared.reference,
        currentReference: destination.prepared.reference,
        maxHops: 10,
      }),
    ).toBeNull();
    database.exec('DROP TRIGGER fail_allocation');
    await transaction(() => relocations.record(evidence));
    expect(
      await relocations.resolve({
        consumer: 'owner:avatar',
        originalReference: source.prepared.reference,
        currentReference: destination.prepared.reference,
        maxHops: 10,
      }),
    ).not.toBeNull();
  });
  it('verifies copied bytes across distinct backends while retaining original attribution', async () => {
    const { registry, relocations, transaction, pair } = fixture();
    const { source, destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const resolved = await relocations.resolve({
      consumer: 'owner:avatar',
      originalReference: source.prepared.reference,
      currentReference: destination.prepared.reference,
      maxHops: 10,
    });
    expect(resolved).toMatchObject({
      originalAssetId: source.id,
      current: { assetId: destination.id },
      content: { bytes: 13 },
    });
    expect(source.prepared.target.binding).not.toBe(destination.prepared.target.binding);
    expect((await registry.readReference(source.prepared.reference))?.asset).toMatchObject({
      prepared: source.prepared,
      consumers: [],
    });
  });
  it('never treats an ordinary replacement as a verified relocation', async () => {
    const { relocations, pair } = fixture();
    const { source, destination } = await pair();
    expect(
      await relocations.resolve({
        consumer: 'owner:avatar',
        originalReference: source.prepared.reference,
        currentReference: destination.prepared.reference,
        maxHops: 10,
      }),
    ).toBeNull();
  });
  it.each(['hash', 'bytes', 'asset'] as const)(
    'rejects mismatched destination readback %s',
    async (mismatch) => {
      const { relocations, transaction, pair } = fixture();
      const { evidence } = await pair();
      if (mismatch === 'hash') evidence.destinationRead.sha256 = '0'.repeat(64);
      if (mismatch === 'bytes') evidence.destinationRead.bytes++;
      if (mismatch === 'asset') evidence.destinationRead.assetId = evidence.sourceAssetId;
      await expect(transaction(() => relocations.record(evidence))).rejects.toThrow(
        'readback does not match',
      );
    },
  );
  it('rejects a partial consumer transfer', async () => {
    const { relocations, transaction, asset, proof } = fixture();
    const source = await asset(['owner:avatar', 'other:avatar']);
    const destination = await asset(['owner:avatar'], source.prepared.reference);
    await expect(transaction(() => relocations.record(proof(source, destination)))).rejects.toThrow(
      'complete captured consumer set',
    );
  });
  it('rejects a dropped historical ownership scope', async () => {
    const { relocations, transaction, asset, proof } = fixture();
    const source = await asset(undefined, null, [
      { subjectId: 'profile:owner', generation: 1 },
      { subjectId: 'profile:historical', generation: 2 },
    ]);
    const destination = await asset(undefined, source.prepared.reference);
    await expect(transaction(() => relocations.record(proof(source, destination)))).rejects.toThrow(
      'dropped an ownership scope',
    );
  });
  it('allows exact replay after another relocation but rejects changed evidence and short traversal limits', async () => {
    const { relocations, transaction, asset, proof, pair } = fixture();
    const { source, destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const last = await asset(undefined, destination.prepared.reference);
    await transaction(() => relocations.record(proof(destination, last)));
    await transaction(() => relocations.record(evidence));
    const request = {
      consumer: 'owner:avatar',
      originalReference: source.prepared.reference,
      currentReference: last.prepared.reference,
    };
    expect(await relocations.resolve({ ...request, maxHops: 2 })).toMatchObject({
      current: { assetId: last.id },
    });
    await expect(relocations.resolve({ ...request, maxHops: 1 })).rejects.toThrow('traversal limit');
    const changed = structuredClone(evidence);
    changed.sourceRead.bytes++;
    changed.destinationRead.bytes++;
    await expect(transaction(() => relocations.record(changed))).rejects.toThrow('different evidence');
  });
  it('does not bridge an ordinary regeneration between relocation edges', async () => {
    const { relocations, transaction, asset, proof, pair } = fixture();
    const { source, destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    const regenerated = await asset(undefined, destination.prepared.reference);
    const last = await asset(undefined, regenerated.prepared.reference);
    await transaction(() => relocations.record(proof(regenerated, last)));
    expect(
      await relocations.resolve({
        consumer: 'owner:avatar',
        originalReference: source.prepared.reference,
        currentReference: last.prepared.reference,
        maxHops: 10,
      }),
    ).toBeNull();
  });
  it('rejects proof after an additional historical scope is erased', async () => {
    const { relocations, writes, transaction, asset, proof } = fixture();
    const scopes = [
      { subjectId: 'profile:owner', generation: 1 },
      { subjectId: 'profile:historical', generation: 2 },
    ];
    const source = await asset(undefined, null, scopes);
    const destination = await asset(undefined, source.prepared.reference, scopes);
    const evidence = proof(source, destination);
    await transaction(() => relocations.record(evidence));
    await transaction(() =>
      writes.forbidWrites(prepareStorageTombstone({ namespace: 'test', ...scopes[1]!, jobId: randomUUID() })),
    );
    await expect(
      relocations.resolve({
        consumer: 'owner:avatar',
        originalReference: source.prepared.reference,
        currentReference: destination.prepared.reference,
        maxHops: 10,
      }),
    ).rejects.toThrow('ownership was erased');
    await expect(transaction(() => relocations.record(evidence))).rejects.toThrow('ownership was erased');
  });
  it('rejects corrupted retirement evidence rather than accepting the receipt alone', async () => {
    const { database, relocations, transaction, pair } = fixture();
    const { source, destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.attribution', NULL) WHERE id LIKE 'sd-retired:%'",
      )
      .run();
    await expect(
      relocations.resolve({
        consumer: 'owner:avatar',
        originalReference: source.prepared.reference,
        currentReference: destination.prepared.reference,
        maxHops: 10,
      }),
    ).rejects.toThrow('exact source retirement');
  });
  it('keeps erasure discovery available after tombstoning and removal of source asset metadata', async () => {
    const { database, relocations, writes, transaction, pair } = fixture();
    const { evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    await transaction(() =>
      writes.forbidWrites(
        prepareStorageTombstone({
          namespace: 'test',
          subjectId: 'profile:owner',
          generation: 1,
          jobId: randomUUID(),
        }),
      ),
    );
    database.prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-asset:%'").run();
    const page = await relocations.listForSubject('profile:owner');
    expect(page.receipts).toEqual([
      expect.objectContaining({
        operationId: evidence.operationId,
        consumers: ['owner:avatar'],
        scopes: [{ subjectId: 'profile:owner', generation: 1 }],
      }),
    ]);
    expect(page.cursor).toBeNull();
  });
  it('discovers every relocation through bounded ownership pages', async () => {
    const { relocations, erasure, transaction, pair } = fixture();
    const ids = new Set<string>();
    for (let index = 0; index < 101; index++) {
      const { evidence } = await pair();
      await transaction(() => relocations.record(evidence));
      ids.add(evidence.operationId);
    }
    const first = await relocations.listForSubject('profile:owner');
    expect(first.receipts).toHaveLength(100);
    expect(first.cursor).not.toBeNull();
    const second = await relocations.listForSubject('profile:owner', first.cursor);
    expect(second.receipts).toHaveLength(1);
    expect(second.cursor).toBeNull();
    expect(new Set([...first.receipts, ...second.receipts].map((receipt) => receipt.operationId))).toEqual(
      ids,
    );
    await expect(relocations.listForSubject('profile:unrelated', first.cursor)).rejects.toThrow('cursor');
    const request = await erasure();
    const erasedFirst = await transaction(() => relocations.eraseForSubject(request));
    expect(erasedFirst).toEqual({ erased: 100, cursor: first.cursor });
    expect(
      await transaction(() => relocations.eraseForSubject({ ...request, after: erasedFirst.cursor })),
    ).toEqual({ erased: 1, cursor: null });
    expect((await relocations.listForSubject('profile:owner')).receipts).toEqual([]);
  });
  it.each(['current', 'original', 'successor'] as const)(
    'surfaces cancellation during a missing %s read',
    async (missing) => {
      const controller = new AbortController();
      const reason = new Error('Cancelled during database read');
      let armed = false;
      const { relocations, pair } = fixture((values, rows) => {
        const key = values[0];
        const prefix = missing === 'successor' ? 'sd-rels:' : 'sd-alias:';
        if (armed && rows.length === 0 && typeof key === 'string' && key.startsWith(prefix))
          controller.abort(reason);
      });
      const { source, destination } = await pair();
      armed = true;
      await expect(
        relocations.resolve({
          consumer: 'owner:avatar',
          maxHops: 10,
          signal: controller.signal,
          originalReference:
            missing === 'original' ? 'https://missing.example/original' : source.prepared.reference,
          currentReference:
            missing === 'current' ? 'https://missing.example/current' : destination.prepared.reference,
        }),
      ).rejects.toBe(reason);
    },
  );
  it.each(['missing', 'generation'] as const)(
    'rejects a %s scope index during replay and discovery',
    async (mismatch) => {
      const { database, relocations, transaction, pair } = fixture();
      const { evidence } = await pair();
      await transaction(() => relocations.record(evidence));
      if (mismatch === 'missing')
        database.prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rel-scope:%'").run();
      else
        database
          .prepare(
            "UPDATE SidedoorState SET state = json_set(state, '$.generation', 99) WHERE id LIKE 'sd-rel-scope:%'",
          )
          .run();
      await expect(transaction(() => relocations.record(evidence))).rejects.toThrow('scope index');
      if (mismatch === 'generation')
        await expect(relocations.listForSubject('profile:owner')).rejects.toThrow('scope attribution');
    },
  );
});
