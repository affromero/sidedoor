import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareStorageCleanup } from '../../../../../src/storage/cleanup/cleanup-state';
import { StorageTargetFence } from '../../../../../src/storage/execution/target-fence';
import { projectSurvivors } from '../../../../../src/storage/local/relocation/projection/project-survivors';
import { validateSurvivorPaths } from '../../../../../src/storage/local/relocation/projection/validate-paths';
import { writeSurvivorProjection } from '../../../../../src/storage/local/relocation/projection/write-survivors';
import { closeRelocationFixtures, fixture } from '../fixture';

afterEach(closeRelocationFixtures);

async function sharedChain() {
  const item = fixture();
  const consumers = ['owner:avatar', 'other:avatar'];
  const scopes = [
    { subjectId: 'profile:owner', generation: 1 },
    { subjectId: 'profile:other', generation: 2 },
  ];
  const source = await item.asset(consumers, null, scopes);
  const middle = await item.asset(consumers, source.prepared.reference, scopes);
  await item.transaction(() => item.relocations.record(item.proof(source, middle, consumers)));
  const terminal = await item.asset(consumers, middle.prepared.reference, scopes);
  await item.transaction(() => item.relocations.record(item.proof(middle, terminal, consumers)));
  const receipts = (await item.relocations.listAll()).receipts;
  const successors = receipts.flatMap((receipt) =>
    receipt.consumers.map((consumer) => {
      const suffix = createHash('sha256')
        .update(JSON.stringify([receipt.sourceAssetId, consumer]))
        .digest('hex');
      const row = item.database
        .prepare('SELECT state FROM SidedoorState WHERE id LIKE ?')
        .get(`sd-rels:1:%:${suffix}`);
      if (!row || typeof row.state !== 'string') throw new Error('Missing successor');
      const state: { operationId: string } = JSON.parse(row.state);
      return { sourceAssetId: receipt.sourceAssetId, consumer, operationId: state.operationId };
    }),
  );
  const graph = {
    namespace: 'test',
    assets: (await item.registry.listAssets()).assets,
    allocations: (await item.registry.listAllocations()).allocations,
    retirements: (await item.registry.listRetirements()).retirements,
    receipts,
    successors,
    paths: consumers.map((consumer) => ({
      consumer,
      originalAssetId: source.id,
      terminal: { kind: 'live' as const, assetId: terminal.id },
      maxHops: 2,
    })),
  };
  return {
    item,
    graph,
    removals: graph.assets.map((asset) => ({
      assetId: asset.id,
      consumers: ['other:avatar'],
      scopes: [scopes[1]!],
    })),
    retirementRemovals: graph.retirements
      .filter((retirement) => retirement.consumer === 'other:avatar')
      .map(({ operationId, consumer }) => ({ operationId, consumer })),
    requirements: graph.assets.map((asset) => ({
      assetId: asset.id,
      consumer: 'owner:avatar',
      scopes: [scopes[0]!],
    })),
  };
}

describe('survivor graph projection', () => {
  it('preserves a shared two-hop history for the remaining owner without writing', async () => {
    const input = await sharedChain();
    const rows = () =>
      input.item.database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    const original = structuredClone(input.graph);
    const projected = projectSurvivors(input);
    expect(input.graph).toEqual(original);
    expect(rows()).toEqual(before);
    expect(validateSurvivorPaths(projected)).toHaveLength(1);
    expect(projected.assets.every((asset) => asset.prepared.scopes.length === 1)).toBe(true);
    expect(projected.receipts.every((receipt) => receipt.schemaVersion === 2)).toBe(true);
    expect(projected.retirements.every((retirement) => retirement.consumer === 'owner:avatar')).toBe(true);
    expect(projected.successors.every((successor) => successor.consumer === 'owner:avatar')).toBe(true);
  });

  it("rejects removing only part of an owner's path", async () => {
    const input = await sharedChain();
    input.removals = input.removals.slice(0, 1);
    expect(() => projectSurvivors(input)).toThrow();
  });

  it('rejects removing a scope required by a surviving owner', async () => {
    const input = await sharedChain();
    input.requirements[0]!.scopes.push(input.removals[0]!.scopes[0]!);
    expect(() => projectSurvivors(input)).toThrow('removed a required survivor scope');
  });

  it('requires a scope assessment for every survivor asset', async () => {
    const input = await sharedChain();
    input.requirements.pop();
    expect(() => projectSurvivors(input)).toThrow('survivor requirement is missing');
  });

  it('requires explicit authority for each retirement removal', async () => {
    const input = await sharedChain();
    input.retirementRemovals.pop();
    expect(() => projectSurvivors(input)).toThrow('retirement has no survivor path');
  });

  it('leaves an already projected graph unchanged when no further removals are requested', async () => {
    const input = await sharedChain();
    const projected = projectSurvivors(input);
    expect(
      projectSurvivors({
        graph: projected,
        removals: [],
        retirementRemovals: [],
        requirements: input.requirements,
      }),
    ).toEqual(projected);
    expect(() => projectSurvivors({ ...input, graph: projected })).toThrow('consumer removal is missing');
  });

  it('rejects removing a retirement for an owner whose asset claim remains', async () => {
    const input = await sharedChain();
    const retained = input.graph.retirements.find((retirement) => retirement.consumer === 'owner:avatar');
    if (!retained) throw new Error('Missing survivor retirement');
    input.retirementRemovals.push({ operationId: retained.operationId, consumer: retained.consumer });
    expect(() => projectSurvivors(input)).toThrow('retirement removal is not authorized for its asset');
  });

  it('rejects a different generation instead of removing an unrelated scope', async () => {
    const input = await sharedChain();
    input.removals[0]!.scopes[0]!.generation++;
    expect(() => projectSurvivors(input)).toThrow('scope removal is missing');
  });

  it('rejects empty records for separately coordinated erasure', async () => {
    const input = await sharedChain();
    for (const removal of input.removals) removal.consumers.push('owner:avatar');
    input.requirements = [];
    expect(() => projectSurvivors(input)).toThrow();
  });
});

describe('survivor graph persistence', () => {
  it('keeps the other owner able to resolve both copies after a scoped cleanup', async () => {
    const input = await sharedChain();
    const job = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'profile:other',
      generation: 2,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await input.item.transaction(() => input.item.cleanup.createJob(job));
    await input.item.transaction(() =>
      writeSurvivorProjection({
        database: input.item.executor,
        dialect: 'sqlite',
        projection: input,
        authorities: [
          { subjectId: job.subjectId, generation: job.generation, jobId: job.id, epoch: job.epoch },
        ],
        verifyApplication: async () => true,
      }),
    );
    const ownerPath = input.graph.paths.find((path) => path.consumer === 'owner:avatar');
    if (!ownerPath) throw new Error('Missing owner path');
    const source = input.graph.assets.find((asset) => asset.id === ownerPath.originalAssetId);
    const terminal = input.graph.assets.find((asset) => asset.id === ownerPath.terminal.assetId);
    if (!source || !terminal) throw new Error('Missing owner endpoints');
    await expect(
      input.item.transaction(() =>
        input.item.relocations.resolve({
          consumer: ownerPath.consumer,
          originalReference: source.prepared.reference,
          currentReference: terminal.prepared.reference,
          maxHops: 2,
        }),
      ),
    ).resolves.toMatchObject({ current: { assetId: terminal.id }, content: { bytes: 13 } });
    expect((await input.item.relocations.listForSubject('profile:other')).receipts).toEqual([]);
    expect((await input.item.relocations.listForSubject('profile:owner')).receipts).toHaveLength(2);
  });

  it('rolls back every change when application evidence is not verified', async () => {
    const input = await sharedChain();
    const job = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'profile:other',
      generation: 2,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await input.item.transaction(() => input.item.cleanup.createJob(job));
    const rows = () =>
      input.item.database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    await expect(
      input.item.transaction(() =>
        writeSurvivorProjection({
          database: input.item.executor,
          dialect: 'sqlite',
          projection: input,
          authorities: [
            { subjectId: job.subjectId, generation: job.generation, jobId: job.id, epoch: job.epoch },
          ],
          verifyApplication: async () => false,
        }),
      ),
    ).rejects.toThrow('application evidence was not verified');
    expect(rows()).toEqual(before);
  });

  it('rolls back the entire projection if a state write fails midway', async () => {
    const input = await sharedChain();
    const job = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'profile:other',
      generation: 2,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await input.item.transaction(() => input.item.cleanup.createJob(job));
    const rows = () =>
      input.item.database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    let interrupted = false;
    const database = {
      async query(sql: string, values: readonly unknown[]) {
        const result = await input.item.executor.query(sql, values);
        if (
          sql.startsWith('UPDATE "SidedoorState"') &&
          typeof values[2] === 'string' &&
          values[2].startsWith('sd-asset:')
        ) {
          interrupted = true;
          throw new Error('Injected state write failure');
        }
        return result;
      },
    };
    await expect(
      input.item.transaction(() =>
        writeSurvivorProjection({
          database,
          dialect: 'sqlite',
          projection: input,
          authorities: [
            { subjectId: job.subjectId, generation: job.generation, jobId: job.id, epoch: job.epoch },
          ],
          verifyApplication: async () => true,
        }),
      ),
    ).rejects.toThrow('Injected state write failure');
    expect(interrupted).toBe(true);
    expect(rows()).toEqual(before);
  });

  it('rejects evidence changed by the application verification callback', async () => {
    const input = await sharedChain();
    const job = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'profile:other',
      generation: 2,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await input.item.transaction(() => input.item.cleanup.createJob(job));
    const rows = () =>
      input.item.database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    await expect(
      input.item.transaction(() =>
        writeSurvivorProjection({
          database: input.item.executor,
          dialect: 'sqlite',
          projection: input,
          authorities: [
            { subjectId: job.subjectId, generation: job.generation, jobId: job.id, epoch: job.epoch },
          ],
          verifyApplication: async () => {
            input.item.database
              .prepare(
                "DELETE FROM SidedoorState WHERE id LIKE 'sd-rel-scope:1:%' AND json_extract(state, '$.subjectId') = ?",
              )
              .run('profile:owner');
            return true;
          },
        }),
      ),
    ).rejects.toThrow('projection evidence changed');
    expect(rows()).toEqual(before);
  });

  it('rejects a survivor whose scope has also been tombstoned', async () => {
    const input = await sharedChain();
    const jobs = [
      { subjectId: 'profile:other', generation: 2 },
      { subjectId: 'profile:owner', generation: 1 },
    ].map((scope) =>
      prepareStorageCleanup({ namespace: 'test', ...scope, retentionPolicy: 'job-id-snapshots-v1' }),
    );
    for (const job of jobs) await input.item.transaction(() => input.item.cleanup.createJob(job));
    const job = jobs[0]!;
    await expect(
      input.item.transaction(() =>
        writeSurvivorProjection({
          database: input.item.executor,
          dialect: 'sqlite',
          projection: input,
          authorities: [
            { subjectId: job.subjectId, generation: job.generation, jobId: job.id, epoch: job.epoch },
          ],
          verifyApplication: async () => true,
        }),
      ),
    ).rejects.toThrow('survivor ownership was erased');
  });

  it('rejects projection when a history target has already been retired', async () => {
    const input = await sharedChain();
    const source = input.graph.assets.find((asset) => asset.consumers.length === 0);
    if (!source) throw new Error('Missing historical asset');
    await input.item.transaction(() =>
      new StorageTargetFence(input.item.executor, 'sqlite').retire({
        ...source.prepared.target,
        retirementId: randomUUID(),
      }),
    );
    const job = prepareStorageCleanup({
      namespace: 'test',
      subjectId: 'profile:other',
      generation: 2,
      retentionPolicy: 'job-id-snapshots-v1',
    });
    await input.item.transaction(() => input.item.cleanup.createJob(job));
    await expect(
      input.item.transaction(() =>
        writeSurvivorProjection({
          database: input.item.executor,
          dialect: 'sqlite',
          projection: input,
          authorities: [
            { subjectId: job.subjectId, generation: job.generation, jobId: job.id, epoch: job.epoch },
          ],
          verifyApplication: async () => true,
        }),
      ),
    ).rejects.toThrow('target is retired');
  });
});
