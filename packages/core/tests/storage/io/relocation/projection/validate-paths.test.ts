import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { validateSurvivorPaths } from '../../../../../src/storage/local/relocation/projection/validate-paths';
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
  const first = await item.asset(consumers, source.prepared.reference, scopes);
  await item.transaction(() => item.relocations.record(item.proof(source, first, consumers)));
  const second = await item.asset(consumers, first.prepared.reference, scopes);
  await item.transaction(() => item.relocations.record(item.proof(first, second, consumers)));
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
  return {
    item,
    source,
    first,
    second,
    graph: {
      namespace: 'test',
      assets: (await item.registry.listAssets()).assets,
      allocations: (await item.registry.listAllocations()).allocations,
      retirements: (await item.registry.listRetirements()).retirements,
      receipts,
      successors,
      paths: consumers.map((consumer) => ({
        consumer,
        originalAssetId: source.id,
        terminal: { kind: 'live' as const, assetId: second.id },
        maxHops: 2,
      })),
    },
  };
}

function projectOtherOwner(input: Awaited<ReturnType<typeof sharedChain>>['graph']) {
  const graph = structuredClone(input);
  const deleted = 'other:avatar';
  graph.assets = graph.assets.map((asset) => ({
    ...asset,
    prepared: {
      ...asset.prepared,
      scopes: asset.prepared.scopes.filter((scope) => scope.subjectId !== 'profile:other'),
    },
    consumers: asset.consumers.filter((consumer) => consumer !== deleted),
  }));
  const byAsset = new Map(graph.assets.map((asset) => [asset.id, asset]));
  graph.allocations = graph.allocations.map((allocation) => ({
    ...allocation,
    claims: allocation.claims.filter((claim) => claim.consumer !== deleted),
  }));
  graph.retirements = graph.retirements
    .filter((retirement) => retirement.consumer !== deleted)
    .map((retirement) => {
      if (!retirement.attribution) throw new Error('Missing retained attribution');
      const asset = byAsset.get(retirement.attribution.assetId);
      if (!asset) throw new Error('Missing projected asset');
      return { ...retirement, attribution: { ...retirement.attribution, prepared: asset.prepared } };
    });
  graph.receipts = graph.receipts.map((receipt) => ({
    ...receipt,
    schemaVersion: 2,
    consumers: receipt.consumers.filter((consumer) => consumer !== deleted),
    scopes: receipt.scopes.filter((scope) => scope.subjectId !== 'profile:other'),
  }));
  graph.successors = graph.successors.filter((successor) => successor.consumer !== deleted);
  graph.paths = graph.paths.filter((path) => path.consumer !== deleted);
  return graph;
}

describe('projected survivor path validation', () => {
  it('accepts a complete two-hop survivor history without modifying records', async () => {
    const { item, graph } = await sharedChain();
    const rows = () =>
      item.database.prepare('SELECT id, revision, state FROM SidedoorState ORDER BY id').all();
    const before = rows();
    const projected = projectOtherOwner(graph);
    expect(() => validateSurvivorPaths(projected)).not.toThrow();
    expect(rows()).toEqual(before);
  });

  it('rejects removal of one edge from an otherwise retained path', async () => {
    const { first, graph } = await sharedChain();
    const projected = projectOtherOwner(graph);
    projected.successors = projected.successors.filter((edge) => edge.sourceAssetId !== first.id);
    expect(() => validateSurvivorPaths(projected)).toThrow('survivor path is incomplete');
  });

  it('rejects removing one owner only from the later edge of a shared chain', async () => {
    const { second, graph } = await sharedChain();
    const operationId = second.prepared.operationId;
    const deleted = 'other:avatar';
    const later = graph.receipts.find((receipt) => receipt.operationId === operationId);
    const allocation = graph.allocations.find((item) => item.assetId === second.id);
    const terminal = graph.assets.find((item) => item.id === second.id);
    if (!later || !allocation || !terminal) throw new Error('Missing later relocation evidence');
    later.consumers = later.consumers.filter((consumer) => consumer !== deleted);
    allocation.claims = allocation.claims.filter((claim) => claim.consumer !== deleted);
    terminal.consumers = terminal.consumers.filter((consumer) => consumer !== deleted);
    graph.retirements = graph.retirements.filter(
      (retirement) => retirement.operationId !== operationId || retirement.consumer !== deleted,
    );
    graph.successors = graph.successors.filter(
      (successor) => successor.operationId !== operationId || successor.consumer !== deleted,
    );
    expect(() => validateSurvivorPaths(graph)).toThrow('survivor path is incomplete');
  });

  it('rejects inconsistent recorded content across a survivor path', async () => {
    const { first, graph } = await sharedChain();
    const projected = projectOtherOwner(graph);
    const receipt = projected.receipts.find((item) => item.operationId === first.prepared.operationId);
    if (!receipt) throw new Error('Missing first receipt');
    receipt.content.bytes++;
    expect(() => validateSurvivorPaths(projected)).toThrow('survivor path content changed');
  });

  it('rejects a receipt whose consumer order differs from its allocation', async () => {
    const { graph } = await sharedChain();
    graph.receipts[0]!.consumers.reverse();
    expect(() => validateSurvivorPaths(graph)).toThrow('relocation claims do not match');
  });

  it('rejects duplicate asset identities and references', async () => {
    const { graph } = await sharedChain();
    const duplicated = structuredClone(graph);
    duplicated.assets.push(duplicated.assets[0]!);
    expect(() => validateSurvivorPaths(duplicated)).toThrow('Duplicate asset');
    const duplicateReference = structuredClone(graph);
    duplicateReference.assets[1]!.prepared.reference = duplicateReference.assets[0]!.prepared.reference;
    expect(() => validateSurvivorPaths(duplicateReference)).toThrow('Duplicate asset reference');
  });

  it('rejects duplicate successors and malformed receipt evidence', async () => {
    const { graph } = await sharedChain();
    const duplicate = structuredClone(graph);
    duplicate.successors.push(duplicate.successors[0]!);
    expect(() => validateSurvivorPaths(duplicate)).toThrow('Duplicate successor');
    const malformed = structuredClone(graph);
    malformed.receipts[0]!.content.bytes = -1;
    expect(() => validateSurvivorPaths(malformed)).toThrow();
  });

  it('rejects two receipts claiming the same destination for one consumer', async () => {
    const { graph } = await sharedChain();
    graph.receipts.push({ ...graph.receipts[0]!, operationId: randomUUID() });
    expect(() => validateSurvivorPaths(graph)).toThrow('receipt destination is ambiguous');
  });

  it('rejects a survivor path that exceeds its explicit limit', async () => {
    const { graph } = await sharedChain();
    graph.paths[0]!.maxHops = 1;
    expect(() => validateSurvivorPaths(graph)).toThrow('survivor path exceeds its traversal limit');
  });

  it('rejects conflicting generations across a relocation edge', async () => {
    const { source, graph } = await sharedChain();
    const asset = graph.assets.find((item) => item.id === source.id);
    if (!asset) throw new Error('Missing source asset');
    const scope = asset.prepared.scopes.find((item) => item.subjectId === 'profile:owner');
    if (!scope) throw new Error('Missing owner scope');
    scope.generation++;
    for (const retirement of graph.retirements)
      if (retirement.attribution?.assetId === source.id)
        retirement.attribution.prepared = structuredClone(asset.prepared);
    expect(() => validateSurvivorPaths(graph)).toThrow('ownership generations conflict');
  });

  it('rejects an uncovered allocation claim even when another owner has a valid path', async () => {
    const { graph } = await sharedChain();
    graph.paths = graph.paths.filter((path) => path.consumer === 'owner:avatar');
    graph.assets = graph.assets.map((asset) => ({
      ...asset,
      consumers: asset.consumers.filter((consumer) => consumer !== 'other:avatar'),
    }));
    expect(() => validateSurvivorPaths(graph)).toThrow('allocation claim has no survivor path');
  });

  it('rejects a source retirement that no longer matches its projected asset', async () => {
    const { graph } = await sharedChain();
    const projected = projectOtherOwner(graph);
    projected.retirements = projected.retirements.slice(1);
    expect(() => validateSurvivorPaths(projected)).toThrow('source retirement does not match');
  });

  it('rejects retirement history that no supplied survivor path explains', async () => {
    const { graph } = await sharedChain();
    const retirement = graph.retirements[0];
    if (!retirement) throw new Error('Missing source retirement');
    graph.retirements.push({ ...retirement, operationId: randomUUID() });
    expect(() => validateSurvivorPaths(graph)).toThrow('retirement has no survivor path');
  });

  it('does not treat an unexplained previous reference as an allocation origin', async () => {
    const { source, graph } = await sharedChain();
    const projected = projectOtherOwner(graph);
    const allocation = projected.allocations.find((item) => item.assetId === source.id);
    if (!allocation) throw new Error('Missing source allocation');
    allocation.claims[0]!.previousReference = 'https://media.example/unknown';
    expect(() => validateSurvivorPaths(projected)).toThrow('origin history is unresolved');
  });

  it('accepts an explicitly verified ordinary replacement boundary', async () => {
    const { source, graph } = await sharedChain();
    const projected = projectOtherOwner(graph);
    const allocation = projected.allocations.find((item) => item.assetId === source.id);
    if (!allocation) throw new Error('Missing source allocation');
    const previousReference = 'https://media.example/ordinary-replacement';
    allocation.claims[0]!.previousReference = previousReference;
    const paths = projected.paths.map((path) => ({
      ...path,
      boundary: { kind: 'verified-replacement' as const, previousReference },
    }));
    expect(() => validateSurvivorPaths({ ...projected, paths })).not.toThrow();
    paths[0]!.boundary.previousReference = 'https://media.example/different';
    expect(() => validateSurvivorPaths({ ...projected, paths })).toThrow('origin history is unresolved');
  });

  it('rejects a replacement boundary that points back to its own asset', async () => {
    const { source, graph } = await sharedChain();
    const projected = projectOtherOwner(graph);
    const allocation = projected.allocations.find((item) => item.assetId === source.id);
    if (!allocation) throw new Error('Missing source allocation');
    allocation.claims[0]!.previousReference = source.prepared.reference;
    const paths = projected.paths.map((path) => ({
      ...path,
      boundary: { kind: 'verified-replacement' as const, previousReference: source.prepared.reference },
    }));
    expect(() => validateSurvivorPaths({ ...projected, paths })).toThrow(
      'origin boundary contradicts relocation evidence',
    );
  });

  it('rejects a replacement boundary that cuts a known relocation edge', async () => {
    const { source, first, graph } = await sharedChain();
    const paths = graph.paths.map((path) =>
      path.consumer === 'owner:avatar'
        ? {
            ...path,
            originalAssetId: first.id,
            boundary: { kind: 'verified-replacement' as const, previousReference: source.prepared.reference },
          }
        : path,
    );
    expect(() => validateSurvivorPaths({ ...graph, paths })).toThrow(
      'origin boundary contradicts relocation evidence',
    );
  });

  it('accepts an exact terminal retirement and rejects a competing replacement', async () => {
    const item = fixture();
    const { source, destination, evidence } = await item.pair();
    await item.transaction(() => item.relocations.record(evidence));
    const operationId = randomUUID();
    await item.transaction(() =>
      item.registry.retire({
        operationId,
        consumer: 'owner:avatar',
        previousReference: destination.prepared.reference,
      }),
    );
    const successors = [
      { sourceAssetId: source.id, consumer: 'owner:avatar', operationId: evidence.operationId },
    ];
    const graph = {
      namespace: 'test',
      assets: (await item.registry.listAssets()).assets,
      allocations: (await item.registry.listAllocations()).allocations,
      retirements: (await item.registry.listRetirements()).retirements,
      receipts: (await item.relocations.listAll()).receipts,
      successors,
      paths: [
        {
          consumer: 'owner:avatar',
          originalAssetId: source.id,
          terminal: { kind: 'retired' as const, assetId: destination.id, operationId },
          maxHops: 1,
        },
      ],
    };
    expect(() => validateSurvivorPaths(graph)).not.toThrow();
    const terminal = graph.retirements.find((retirement) => retirement.operationId === operationId);
    if (!terminal) throw new Error('Missing terminal retirement');
    const ambiguous = structuredClone(graph);
    ambiguous.retirements.push({ ...terminal, operationId: randomUUID() });
    expect(() => validateSurvivorPaths(ambiguous)).toThrow('terminal retirement is missing or ambiguous');
    const unattributed = structuredClone(graph);
    unattributed.retirements.push({
      ...terminal,
      operationId: randomUUID(),
      attribution: null,
      status: 'unresolved',
    });
    expect(() => validateSurvivorPaths(unattributed)).toThrow(
      'terminal retirement attribution does not match',
    );
    const conflictingRetirement = structuredClone(graph);
    conflictingRetirement.retirements.push({
      ...terminal,
      operationId: randomUUID(),
      replacementAssetId: source.id,
    });
    expect(() => validateSurvivorPaths(conflictingRetirement)).toThrow(
      'terminal retirement has a competing replacement',
    );
    await item.asset(undefined, destination.prepared.reference);
    const competing = {
      ...graph,
      assets: (await item.registry.listAssets()).assets,
      allocations: (await item.registry.listAllocations()).allocations,
    };
    expect(() => validateSurvivorPaths(competing)).toThrow('terminal retirement has a competing replacement');
  });
});
