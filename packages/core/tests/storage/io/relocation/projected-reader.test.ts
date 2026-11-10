import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageRelocationRegistry as LegacyRelocationRegistry } from 'thesidedoor-core-legacy/storage';
import { prepareStorageCleanup } from '../../../../src/storage/cleanup/cleanup-state';
import { closeRelocationFixtures, fixture } from './fixture';

afterEach(closeRelocationFixtures);

describe('projected relocation receipts', () => {
  it('resolves a retained consumer after the other consumer and scope are removed', async () => {
    const { database, executor, relocations, transaction, asset, proof } = fixture();
    const consumers = ['owner:avatar', 'other:avatar'];
    const scopes = [
      { subjectId: 'profile:owner', generation: 1 },
      { subjectId: 'profile:other', generation: 2 },
    ];
    const source = await asset(consumers, null, scopes);
    const destination = await asset(consumers, source.prepared.reference, scopes);
    const original = proof(source, destination, consumers);
    await transaction(() => relocations.record(original));
    database.exec('BEGIN');
    try {
      database
        .prepare(
          "UPDATE SidedoorState SET state = json_remove(state, '$.prepared.scopes[0]') WHERE id LIKE 'sd-asset:1:%'",
        )
        .run();
      database
        .prepare("UPDATE SidedoorState SET state = json_remove(state, '$.consumers[1]') WHERE id LIKE ?")
        .run(`sd-asset:1:%:${destination.id}`);
      database
        .prepare(
          "UPDATE SidedoorState SET state = json_remove(state, '$.claims[1]') WHERE id LIKE 'sd-allocation:1:%'",
        )
        .run();
      database
        .prepare(
          "DELETE FROM SidedoorState WHERE id LIKE 'sd-retired:1:%' AND json_extract(state, '$.consumer') = ?",
        )
        .run('owner:avatar');
      database
        .prepare(
          "UPDATE SidedoorState SET state = json_remove(state, '$.attribution.prepared.scopes[0]') WHERE id LIKE 'sd-retired:1:%'",
        )
        .run();
      database
        .prepare(
          "UPDATE SidedoorState SET state = json_set(json_remove(state, '$.consumers[1]', '$.scopes[1]'), '$.schemaVersion', 2) WHERE id LIKE 'sd-rel:1:%'",
        )
        .run();
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      database
        .prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rel-scope:1:%' AND id LIKE ?")
        .run(`%:${hash('profile:owner')}:%`);
      database
        .prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-rels:1:%' AND id LIKE ?")
        .run(`%:${hash(JSON.stringify([source.id, 'owner:avatar']))}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    const retained = { ...original, consumers: ['other:avatar'] };
    await expect(transaction(() => relocations.verifyExisting(retained))).resolves.toBeUndefined();
    await expect(
      transaction(() =>
        relocations.resolve({
          consumer: 'other:avatar',
          originalReference: source.prepared.reference,
          currentReference: destination.prepared.reference,
          maxHops: 1,
        }),
      ),
    ).resolves.toMatchObject({ current: { assetId: destination.id }, content: { bytes: 13 } });
    expect((await relocations.listForSubject('profile:owner')).receipts).toEqual([]);
    expect((await relocations.listForSubject('profile:other')).receipts).toHaveLength(1);
    const legacy = new LegacyRelocationRegistry(executor, 'sqlite', 'test');
    await expect(transaction(() => legacy.record(retained))).rejects.toThrow();
  });

  it('verifies a projected receipt while older readers reject it', async () => {
    const { database, executor, relocations, transaction, pair } = fixture();
    const { source, destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.schemaVersion', 2) WHERE id LIKE 'sd-rel:1:%'",
      )
      .run();
    await expect(transaction(() => relocations.verifyExisting(evidence))).resolves.toBeUndefined();
    await expect(
      transaction(() =>
        relocations.resolve({
          consumer: 'owner:avatar',
          originalReference: source.prepared.reference,
          currentReference: destination.prepared.reference,
          maxHops: 1,
        }),
      ),
    ).resolves.toMatchObject({ current: { assetId: destination.id } });
    const legacy = new LegacyRelocationRegistry(executor, 'sqlite', 'test');
    await expect(transaction(() => legacy.record(evidence))).rejects.toThrow();
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.content.bytes', 99) WHERE id LIKE 'sd-rel:1:%'",
      )
      .run();
    await expect(transaction(() => relocations.verifyExisting(evidence))).rejects.toThrow(
      'different evidence',
    );
  });

  it('requires the application to verify projected consumer ownership before erasure', async () => {
    const { database, executor, registry, relocations, transaction, pair, erasure } = fixture();
    const { destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.schemaVersion', 2) WHERE id LIKE 'sd-rel:1:%'",
      )
      .run();
    database.exec(
      'CREATE TABLE ConsumerOwner (consumer TEXT PRIMARY KEY, subject TEXT NOT NULL, generation INTEGER NOT NULL)',
    );
    database.prepare('INSERT INTO ConsumerOwner VALUES (?, ?, ?)').run('owner:avatar', 'profile:owner', 1);
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: destination.prepared.reference,
      }),
    );
    const request = await erasure();
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    expect(
      await transaction(() =>
        relocations.eraseForSubject({
          ...request,
          deferProjectedOperationIds: [evidence.operationId],
        }),
      ),
    ).toEqual({ erased: 0, cursor: null });
    expect(rows()).toEqual(before);
    await expect(transaction(() => relocations.eraseForSubject(request))).rejects.toThrow(
      'Projected relocation erasure ownership was not verified',
    );
    await expect(
      transaction(() =>
        relocations.eraseForSubject({ ...request, verifyProjectedErasure: async () => false }),
      ),
    ).rejects.toThrow('ownership was not verified');
    expect(rows()).toEqual(before);
    const legacy = new LegacyRelocationRegistry(executor, 'sqlite', 'test');
    await expect(transaction(() => legacy.eraseForSubject(request))).rejects.toThrow();
    expect(rows()).toEqual(before);
    await expect(
      transaction(() =>
        relocations.eraseForSubject({
          ...request,
          verifyProjectedErasure: async (input) => {
            if (
              input.scopes.some(
                (scope) => scope.subjectId !== input.subjectId || scope.generation !== input.generation,
              )
            )
              return false;
            for (const consumer of input.consumers) {
              const owners = await executor.query(
                'SELECT subject, generation FROM ConsumerOwner WHERE consumer = ?',
                [consumer],
              );
              if (
                owners.length !== 1 ||
                owners[0]?.subject !== input.subjectId ||
                owners[0]?.generation !== input.generation
              )
                return false;
            }
            return true;
          },
        }),
      ),
    ).resolves.toMatchObject({ erased: 1 });
  });

  it('preserves a projected receipt when a consumer belongs to another learner', async () => {
    const { database, executor, registry, relocations, transaction, asset, proof, erasure } = fixture();
    const consumers = ['owner:avatar', 'other:avatar'];
    const scopes = [
      { subjectId: 'profile:owner', generation: 1 },
      { subjectId: 'profile:other', generation: 2 },
    ];
    const source = await asset(consumers, null, scopes);
    const destination = await asset(consumers, source.prepared.reference, scopes);
    await transaction(() => relocations.record(proof(source, destination, consumers)));
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.schemaVersion', 2) WHERE id LIKE 'sd-rel:1:%'",
      )
      .run();
    const request = await erasure();
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    await expect(
      transaction(() =>
        relocations.eraseForSubject({
          ...request,
          verifyProjectedErasure: async (receipt) =>
            receipt.consumers.every((consumer) => consumer === 'owner:avatar'),
        }),
      ),
    ).rejects.toThrow('ownership was not verified');
    expect(rows()).toEqual(before);
    expect((await relocations.listForSubject('profile:other')).receipts).toHaveLength(1);
    await expect(
      transaction(() =>
        relocations.eraseForSubject({ ...request, verifyProjectedErasure: async () => true }),
      ),
    ).rejects.toThrow('still has live consumers');
    expect(rows()).toEqual(before);
    for (const consumer of consumers)
      await transaction(() =>
        registry.retire({
          operationId: randomUUID(),
          consumer,
          previousReference: destination.prepared.reference,
        }),
      );
    database.exec('CREATE TABLE ScopeDependency (subject TEXT PRIMARY KEY)');
    database.prepare('INSERT INTO ScopeDependency VALUES (?)').run('profile:other');
    const retired = rows();
    await expect(
      transaction(() =>
        relocations.eraseForSubject({
          ...request,
          verifyProjectedErasure: async (input) => {
            for (const scope of input.scopes) {
              const dependencies = await executor.query(
                'SELECT subject FROM ScopeDependency WHERE subject = ?',
                [scope.subjectId],
              );
              if (scope.subjectId !== input.subjectId && dependencies.length) return false;
            }
            return true;
          },
        }),
      ),
    ).rejects.toThrow('ownership was not verified');
    expect(rows()).toEqual(retired);
  });

  it('does not confuse an independent asset with the retired relocation endpoints', async () => {
    const { database, registry, relocations, transaction, asset, proof, erasure } = fixture();
    const source = await asset();
    const destination = await asset(undefined, source.prepared.reference);
    await transaction(() => relocations.record(proof(source, destination)));
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: destination.prepared.reference,
      }),
    );
    const independent = await asset(['owner:avatar'], null, [{ subjectId: 'profile:other', generation: 2 }]);
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.schemaVersion', 2) WHERE id LIKE 'sd-rel:1:%'",
      )
      .run();
    const request = await erasure();
    await expect(
      transaction(() =>
        relocations.eraseForSubject({ ...request, verifyProjectedErasure: async () => true }),
      ),
    ).resolves.toMatchObject({ erased: 1 });
    expect((await registry.readAsset(independent.id))?.asset.consumers).toEqual(['owner:avatar']);
  });

  it('retains unresolved cleanup evidence when a projected endpoint is missing', async () => {
    const { database, registry, relocations, cleanup, classifier, transaction, pair, erasure } = fixture();
    const { source, destination, evidence } = await pair();
    await transaction(() => relocations.record(evidence));
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: destination.prepared.reference,
      }),
    );
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.schemaVersion', 2) WHERE id LIKE 'sd-rel:1:%'",
      )
      .run();
    database
      .prepare("DELETE FROM SidedoorState WHERE id LIKE 'sd-asset:1:%' AND id LIKE ?")
      .run(`%:${source.id}`);
    const request = await erasure();
    await expect(
      transaction(() =>
        relocations.eraseForSubject({ ...request, verifyProjectedErasure: async () => true }),
      ),
    ).resolves.toMatchObject({ erased: 1 });
    const manifests = await cleanup.listManifests(request.jobId);
    expect(manifests.pages).toHaveLength(1);
    const page = await classifier.inspectPage({ ...request, pageId: manifests.pages[0]!.id });
    expect(page.entries[0]).toMatchObject({ status: 'unresolved', reason: 'missing_attribution' });
  });

  it('does not erase a receipt when an endpoint belongs to a different scope', async () => {
    const { database, registry, relocations, cleanup, transaction, asset, proof } = fixture();
    const owner = { subjectId: 'profile:owner', generation: 1 };
    const other = { subjectId: 'profile:other', generation: 2 };
    const source = await asset(['owner:avatar'], null, [owner]);
    const destination = await asset(['owner:avatar'], source.prepared.reference, [owner, other]);
    await transaction(() => relocations.record(proof(source, destination)));
    await transaction(() =>
      registry.retire({
        operationId: randomUUID(),
        consumer: 'owner:avatar',
        previousReference: destination.prepared.reference,
      }),
    );
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.schemaVersion', 2) WHERE id LIKE 'sd-rel:1:%'",
      )
      .run();
    const job = prepareStorageCleanup({
      namespace: 'test',
      ...other,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await transaction(() => cleanup.createJob(job));
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    await expect(
      transaction(() =>
        relocations.eraseForSubject({
          ...other,
          jobId: job.id,
          epoch: job.epoch,
          verifyProjectedErasure: async () => true,
        }),
      ),
    ).rejects.toThrow('endpoint belongs to another scope');
    expect(rows()).toEqual(before);
    expect((await relocations.listForSubject(owner.subjectId)).receipts).toHaveLength(1);
  });

  it('rolls back earlier receipt erasure if a later projected receipt is refused', async () => {
    const { database, registry, relocations, transaction, pair, erasure } = fixture();
    const first = await pair();
    const second = await pair();
    for (const item of [first, second]) {
      await transaction(() => relocations.record(item.evidence));
      await transaction(() =>
        registry.retire({
          operationId: randomUUID(),
          consumer: 'owner:avatar',
          previousReference: item.destination.prepared.reference,
        }),
      );
    }
    database
      .prepare(
        "UPDATE SidedoorState SET state = json_set(state, '$.schemaVersion', 2) WHERE id LIKE 'sd-rel:1:%'",
      )
      .run();
    const request = await erasure();
    const firstId = [first.evidence.operationId, second.evidence.operationId].sort()[0];
    const rows = () => database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    await expect(
      transaction(() =>
        relocations.eraseForSubject({
          ...request,
          verifyProjectedErasure: async (receipt) => receipt.operationId === firstId,
        }),
      ),
    ).rejects.toThrow('ownership was not verified');
    expect(rows()).toEqual(before);
  });
});
