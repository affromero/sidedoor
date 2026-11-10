import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  StorageBackendRegistry,
  prepareStorageBackend,
} from '../../../src/storage/registry/backend-registry';
import {
  StorageReferenceRegistry,
  prepareStorageReference,
} from '../../../src/storage/registry/reference-registry';
import {
  StorageWriteJournal,
  prepareStorageTombstone,
  prepareStorageWrite,
} from '../../../src/storage/execution/write-journal';
import { prepareStorageCleanup } from '../../../src/storage/cleanup/cleanup-state';
import { closeRelocationFixtures, fixture } from './relocation/fixture';

afterEach(closeRelocationFixtures);

describe('explicit storage relocation provenance', () => {
  it('admits one exact legacy asset atomically and repeats only the same binding', async () => {
    const { asset, classifier, cleanup, registry, transaction, database, writes } = fixture();
    const originalScope = { subjectId: 'course:one', generation: 1 };
    const saved = await asset(['class:one:worksheet'], null, [originalScope]);
    const job = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'class:one',
      generation: 2,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await transaction(() => cleanup.createJob(job));
    const input = {
      jobId: job.id,
      epoch: job.epoch,
      subjectId: job.subjectId,
      generation: job.generation,
      originalScope,
      consumer: 'class:one:worksheet',
      reference: saved.prepared.reference,
      verifyOwnership: async () => true,
      operationId: randomUUID(),
    };
    const unrelated = await asset(['class:one:worksheet'], null, [originalScope]);
    const unrelatedOperation = randomUUID();
    await transaction(() =>
      registry.retire({
        operationId: unrelatedOperation,
        consumer: input.consumer,
        previousReference: unrelated.prepared.reference,
      }),
    );
    await expect(
      transaction(() =>
        classifier.admitDelegatedAsset({
          ...input,
          operationId: unrelatedOperation,
          reference: unrelated.prepared.reference,
        }),
      ),
    ).rejects.toThrow('binding is missing');
    await expect(
      transaction(async () => {
        await classifier.admitDelegatedAsset(input);
        throw new Error('Rollback admission');
      }),
    ).rejects.toThrow('Rollback admission');
    expect(await registry.resolve({ consumer: input.consumer, reference: input.reference })).not.toBeNull();
    const admitted = await transaction(() => classifier.admitDelegatedAsset(input));
    expect(admitted.assetId).toBe(saved.id);
    const binding = database.prepare("SELECT state FROM SidedoorState WHERE id LIKE 'sd-cda:%'").get();
    expect(binding?.state).not.toContain(input.consumer);
    expect(binding?.state).not.toContain(input.reference);
    expect(binding?.state).not.toContain(originalScope.subjectId);
    const lateWrite = prepareStorageWrite({
      namespace: 'test',
      ...originalScope,
      target: saved.prepared.target,
    });
    await expect(transaction(() => writes.begin(lateWrite, originalScope.generation))).rejects.toThrow(
      'target is retired',
    );
    await expect(
      transaction(() =>
        registry.replace({ consumer: 'class:two:worksheet', previousReference: null, next: saved.prepared }),
      ),
    ).rejects.toThrow('target is retired');
    expect(await transaction(() => classifier.admitDelegatedAsset(input))).toEqual(admitted);
    expect((await cleanup.listManifests(job.id)).pages).toHaveLength(1);
    const otherJob = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'class:other',
      generation: 3,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await transaction(() => cleanup.createJob(otherJob));
    await expect(
      transaction(() =>
        classifier.admitDelegatedAsset({
          ...input,
          jobId: otherJob.id,
          subjectId: otherJob.subjectId,
          generation: otherJob.generation,
        }),
      ),
    ).rejects.toThrow('binding mismatch');
    const [page] = (await cleanup.listManifests(job.id)).pages;
    if (!page) throw new Error('Missing delegated manifest');
    const forged = {
      ...(page.entries[0] as Record<string, unknown>),
      jobId: otherJob.id,
      subjectId: otherJob.subjectId,
      generation: otherJob.generation,
    };
    await transaction(() =>
      cleanup.recordManifestPage(otherJob.id, otherJob.epoch, {
        id: 'forged',
        entries: [forged],
      }),
    );
    await expect(
      classifier.inspectPage({
        jobId: otherJob.id,
        epoch: otherJob.epoch,
        subjectId: otherJob.subjectId,
        generation: otherJob.generation,
        pageId: 'forged',
      }),
    ).rejects.toThrow('binding mismatch');
    await expect(
      transaction(() =>
        classifier.admitDelegatedAsset({ ...input, originalScope: { ...originalScope, generation: 3 } }),
      ),
    ).rejects.toThrow();
    database
      .prepare(
        `UPDATE SidedoorState SET state = json_insert(state, '$.consumers[#]', ?)
      WHERE json_extract(state, '$.kind') = 'storage_asset' AND json_extract(state, '$.id') = ?`,
      )
      .run('class:two:worksheet', saved.id);
    expect(
      (
        await classifier.inspectPage({
          jobId: job.id,
          epoch: job.epoch,
          subjectId: job.subjectId,
          generation: job.generation,
          pageId: `delegated:${input.operationId}`,
        })
      ).entries,
    ).toEqual([{ index: 0, status: 'unresolved', reason: 'live_consumers' }]);
    const targetDigest = createHash('sha256')
      .update(JSON.stringify([saved.prepared.target.binding, saved.prepared.target.key]))
      .digest('hex');
    database.prepare('DELETE FROM SidedoorState WHERE id = ?').run(`sd-tf:1:${targetDigest}`);
    await expect(
      classifier.inspectPage({
        jobId: job.id,
        epoch: job.epoch,
        subjectId: job.subjectId,
        generation: job.generation,
        pageId: `delegated:${input.operationId}`,
      }),
    ).rejects.toThrow('target retirement is missing');
  });
  it('preflights one legacy asset only for its verified class cleanup', async () => {
    const { asset, classifier, cleanup, transaction, writes, relocations, proof, executor } = fixture();
    const originalScope = { subjectId: 'course:one', generation: 1 };
    const profileScope = { subjectId: 'profile:owner', generation: 4 };
    const saved = await asset(['class:one:worksheet'], null, [originalScope, profileScope]);
    const job = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'class:one',
      generation: 2,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await transaction(() => cleanup.createJob(job));
    const input = {
      jobId: job.id,
      epoch: job.epoch,
      subjectId: job.subjectId,
      generation: job.generation,
      originalScope,
      consumer: 'class:one:worksheet',
      reference: saved.prepared.reference,
      verifyOwnership: async () => true,
    };
    const result = await transaction(() => classifier.inspectDelegatedAsset(input));
    expect(result.assetId).toBe(saved.id);
    await expect(
      transaction(() => classifier.inspectDelegatedAsset({ ...input, verifyOwnership: async () => false })),
    ).rejects.toThrow('ownership was not verified');
    await expect(
      transaction(() =>
        classifier.inspectDelegatedAsset({ ...input, originalScope: { ...originalScope, generation: 3 } }),
      ),
    ).rejects.toThrow('original scope does not match');
    await expect(
      transaction(() => classifier.inspectDelegatedAsset({ ...input, generation: 3 })),
    ).rejects.toThrow('cleanup authority');
    const shared = await asset(['class:one:worksheet', 'class:two:worksheet'], null, [originalScope]);
    await expect(
      transaction(() => classifier.inspectDelegatedAsset({ ...input, reference: shared.prepared.reference })),
    ).rejects.toThrow('other consumers');
    const first = await asset(['class:one:worksheet'], null, [originalScope]);
    const second = await asset(['class:one:worksheet'], first.prepared.reference, [originalScope]);
    await transaction(() => relocations.record(proof(first, second, ['class:one:worksheet'])));
    await expect(
      transaction(() => classifier.inspectDelegatedAsset({ ...input, reference: second.prepared.reference })),
    ).rejects.toThrow('relocation history');
    const registered = await new StorageBackendRegistry(executor, 'sqlite', 'test').get(
      saved.prepared.target.backendId,
    );
    if (!registered || registered.descriptor.kind !== 'object') throw new Error('Missing fixture backend');
    const alternate = prepareStorageBackend('test', {
      ...registered.descriptor,
      publicUrl: 'https://alternate.example',
    });
    expect(alternate.id).not.toBe(saved.prepared.target.backendId);
    await transaction(() => new StorageBackendRegistry(executor, 'sqlite', 'test').register(alternate));
    const pending = prepareStorageWrite({
      namespace: 'test',
      ...profileScope,
      target: { ...saved.prepared.target, backendId: alternate.id },
    });
    await transaction(() => writes.begin(pending, profileScope.generation));
    await expect(transaction(() => classifier.inspectDelegatedAsset(input))).rejects.toThrow(
      'retained write intents',
    );
    await transaction(() => writes.finish(pending, { kind: 'not_created' }));
    const foreignBackend = prepareStorageBackend('other-app', registered.descriptor);
    await transaction(() =>
      new StorageBackendRegistry(executor, 'sqlite', 'other-app').register(foreignBackend),
    );
    const foreignWrites = new StorageWriteJournal(executor, 'sqlite', 'other-app');
    const foreignWrite = prepareStorageWrite({
      namespace: 'other-app',
      subjectId: 'foreign:owner',
      generation: 1,
      target: { ...saved.prepared.target, backendId: foreignBackend.id },
    });
    await transaction(() => foreignWrites.begin(foreignWrite, 1));
    await expect(
      transaction(() => classifier.admitDelegatedAsset({ ...input, operationId: randomUUID() })),
    ).rejects.toThrow('target has retained writes');
    await transaction(() => foreignWrites.finish(foreignWrite, { kind: 'not_created' }));
    await transaction(() => classifier.admitDelegatedAsset({ ...input, operationId: randomUUID() }));
    await expect(
      transaction(() => foreignWrites.begin({ ...foreignWrite, operationId: randomUUID() }, 1)),
    ).rejects.toThrow('target is retired');
  });
  it('preserves a physical target still referenced by another namespace', async () => {
    const { asset, classifier, cleanup, registry, transaction, executor } = fixture();
    const originalScope = { subjectId: 'course:one', generation: 1 };
    const saved = await asset(['class:one:worksheet'], null, [originalScope]);
    const registered = await new StorageBackendRegistry(executor, 'sqlite', 'test').get(
      saved.prepared.target.backendId,
    );
    if (!registered) throw new Error('Missing fixture backend');
    const foreignBackend = prepareStorageBackend('other-app', registered.descriptor);
    const foreignRegistry = new StorageReferenceRegistry(executor, 'sqlite', 'other-app');
    const foreignReference = prepareStorageReference({
      ...saved.prepared,
      namespace: 'other-app',
      operationId: randomUUID(),
      target: { ...saved.prepared.target, backendId: foreignBackend.id },
      scopes: [{ subjectId: 'foreign:owner', generation: 1 }],
    });
    const job = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'class:one',
      generation: 2,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await transaction(async () => {
      await new StorageBackendRegistry(executor, 'sqlite', 'other-app').register(foreignBackend);
      await foreignRegistry.replace({
        consumer: 'foreign:worksheet',
        previousReference: null,
        next: foreignReference,
      });
      await cleanup.createJob(job);
    });
    const input = {
      jobId: job.id,
      epoch: job.epoch,
      subjectId: job.subjectId,
      generation: job.generation,
      originalScope,
      consumer: 'class:one:worksheet',
      reference: saved.prepared.reference,
      verifyOwnership: async () => true,
      operationId: randomUUID(),
    };
    await expect(transaction(() => classifier.admitDelegatedAsset(input))).rejects.toThrow('live consumers');
    expect(await registry.resolve({ consumer: input.consumer, reference: input.reference })).not.toBeNull();
    expect(
      await foreignRegistry.resolve({ consumer: 'foreign:worksheet', reference: input.reference }),
    ).not.toBeNull();
  });
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
