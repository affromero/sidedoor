import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  prepareStorageReferenceClaims,
  storageAssetSchema,
  storageReferenceAllocationSchema,
  storageReferenceAssetId,
  storageReferenceRetirementSchema,
} from '../../../registry/reference-registry';
import { combinedScopes, contentSchema, digest, identity, receiptSchema } from '../records';

const successorSchema = z
  .object({ sourceAssetId: digest, consumer: identity, operationId: z.uuid() })
  .strict();
const terminalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('live'), assetId: digest }).strict(),
  z.object({ kind: z.literal('retired'), assetId: digest, operationId: z.uuid() }).strict(),
]);
const pathSchema = z
  .object({
    consumer: identity,
    originalAssetId: digest,
    boundary: z
      .object({ kind: z.literal('verified-replacement'), previousReference: z.string().min(1) })
      .strict()
      .optional(),
    terminal: terminalSchema,
    maxHops: z.number().int().min(1).max(10_000),
  })
  .strict();
const graphSchema = z
  .object({
    namespace: identity,
    assets: z.array(storageAssetSchema),
    allocations: z.array(storageReferenceAllocationSchema),
    retirements: z.array(storageReferenceRetirementSchema),
    receipts: z.array(receiptSchema),
    successors: z.array(successorSchema),
    paths: z.array(pathSchema),
  })
  .strict();

export type SurvivorGraph = z.infer<typeof graphSchema>;
export type SurvivorPath = SurvivorGraph['paths'][number];

function pair(left: string, right: string): string {
  return JSON.stringify([left, right]);
}

function uniqueMap<Value>(values: readonly Value[], key: (value: Value) => string, label: string) {
  const result = new Map<string, Value>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) throw new Error(`Duplicate ${label} in storage projection`);
    result.set(id, value);
  }
  return result;
}

/**
 * Validate paths in an already-projected graph. The caller must provide complete,
 * independently verified ownership and copy evidence in one Serializable snapshot.
 * A replacement boundary is the caller's independently verified assertion that
 * the previous reference is outside this relocation lineage.
 * This function does not authorize changes, erasure, or storage deletion.
 */
export function validateSurvivorPaths(input: z.input<typeof graphSchema>) {
  const graph = graphSchema.parse(input);
  const assets = uniqueMap(graph.assets, (asset) => asset.id, 'asset');
  uniqueMap(graph.assets, (asset) => asset.prepared.reference, 'asset reference');
  const allocations = uniqueMap(graph.allocations, (allocation) => allocation.assetId, 'allocation');
  const receipts = uniqueMap(graph.receipts, (receipt) => receipt.operationId, 'receipt');
  uniqueMap(
    graph.paths,
    (path) => JSON.stringify([path.consumer, path.originalAssetId, path.terminal]),
    'survivor path',
  );
  const retirements = uniqueMap(
    graph.retirements,
    (retirement) => pair(retirement.operationId, retirement.consumer),
    'retirement',
  );
  const successors = uniqueMap(
    graph.successors,
    (successor) => pair(successor.sourceAssetId, successor.consumer),
    'successor',
  );
  const coveredAssets = new Set<string>();
  const coveredEdges = new Set<string>();
  const coveredRetirements = new Set<string>();
  const liveTerminals = new Set<string>();
  const coverage: { path: SurvivorPath; assetIds: string[] }[] = [];
  const retirementsByReference = new Map<string, SurvivorGraph['retirements']>();
  const retirementsByAsset = new Map<string, SurvivorGraph['retirements']>();
  const replacementClaims = new Set<string>();
  const incomingReceipts = new Set<string>();
  for (const receipt of graph.receipts)
    for (const consumer of receipt.consumers) {
      const id = pair(receipt.destinationAssetId, consumer);
      if (incomingReceipts.has(id)) throw new Error('Storage projection receipt destination is ambiguous');
      incomingReceipts.add(id);
    }
  const addRetirement = (
    index: Map<string, SurvivorGraph['retirements']>,
    key: string,
    retirement: SurvivorGraph['retirements'][number],
  ) => {
    const values = index.get(key) ?? [];
    values.push(retirement);
    index.set(key, values);
  };
  let pathVisits = 0;

  for (const asset of graph.assets) {
    if (asset.prepared.namespace !== graph.namespace || storageReferenceAssetId(asset.prepared) !== asset.id)
      throw new Error('Storage projection asset identity does not match');
    const allocation = allocations.get(asset.id);
    if (
      !allocation ||
      allocation.namespace !== graph.namespace ||
      allocation.operationId !== asset.prepared.operationId
    )
      throw new Error('Storage projection asset allocation does not match');
    if (!isDeepStrictEqual(allocation.claims, prepareStorageReferenceClaims(allocation.claims)))
      throw new Error('Storage projection allocation claims are not canonical');
    if (
      new Set(asset.consumers).size !== asset.consumers.length ||
      asset.consumers.some((consumer) => !allocation.claims.some((claim) => claim.consumer === consumer))
    )
      throw new Error('Storage projection asset consumers do not match allocation');
  }
  for (const allocation of graph.allocations) {
    if (!assets.has(allocation.assetId)) throw new Error('Storage projection allocation asset is missing');
    for (const claim of allocation.claims)
      if (claim.previousReference !== null)
        replacementClaims.add(pair(claim.consumer, claim.previousReference));
  }
  for (const retirement of graph.retirements) {
    if (retirement.namespace !== graph.namespace)
      throw new Error('Storage projection retirement namespace does not match');
    if (retirement.attribution) {
      const asset = assets.get(retirement.attribution.assetId);
      if (!asset || !isDeepStrictEqual(retirement.attribution.prepared, asset.prepared))
        throw new Error('Storage projection retirement attribution does not match');
      addRetirement(
        retirementsByAsset,
        pair(retirement.consumer, retirement.attribution.assetId),
        retirement,
      );
    }
    addRetirement(
      retirementsByReference,
      pair(retirement.consumer, retirement.previousReference),
      retirement,
    );
  }
  for (const successor of graph.successors) {
    const receipt = receipts.get(successor.operationId);
    if (
      !receipt ||
      receipt.sourceAssetId !== successor.sourceAssetId ||
      !receipt.consumers.includes(successor.consumer)
    )
      throw new Error('Storage projection successor does not match receipt');
  }

  for (const path of graph.paths) {
    let assetId = path.originalAssetId;
    const visited = new Set<string>();
    let content: z.infer<typeof contentSchema> | null = null;
    let hops = 0;
    while (true) {
      if (++pathVisits > 1_000_000) throw new Error('Storage projection path validation exceeds its limit');
      if (visited.has(assetId)) throw new Error('Storage projection survivor path contains a cycle');
      visited.add(assetId);
      const asset = assets.get(assetId);
      const allocation = allocations.get(assetId);
      const claim = allocation?.claims.find((item) => item.consumer === path.consumer);
      if (!asset || !allocation || !claim)
        throw new Error('Storage projection survivor allocation is missing');
      if (hops === 0) {
        if (claim.previousReference === null && path.boundary)
          throw new Error('Storage projection survivor origin boundary does not match');
        if (
          claim.previousReference !== null &&
          (!path.boundary || path.boundary.previousReference !== claim.previousReference)
        )
          throw new Error('Storage projection survivor origin history is unresolved');
        if (
          path.boundary &&
          (path.boundary.previousReference === asset.prepared.reference ||
            incomingReceipts.has(pair(assetId, path.consumer)))
        )
          throw new Error('Storage projection survivor origin boundary contradicts relocation evidence');
      }
      coveredAssets.add(pair(assetId, path.consumer));
      if (assetId === path.terminal.assetId) {
        if (successors.has(pair(assetId, path.consumer)))
          throw new Error('Storage projection survivor terminal has a successor');
        if (path.terminal.kind === 'live') {
          if (!asset.consumers.includes(path.consumer))
            throw new Error('Storage projection survivor is not a live owner');
          liveTerminals.add(pair(assetId, path.consumer));
        } else {
          const retirement = retirements.get(pair(path.terminal.operationId, path.consumer));
          if (
            asset.consumers.includes(path.consumer) ||
            !retirement ||
            retirement.status !== 'pending' ||
            retirement.previousReference !== asset.prepared.reference ||
            retirement.replacementAssetId !== null ||
            !retirement.attribution ||
            retirement.attribution.assetId !== assetId ||
            !isDeepStrictEqual(retirement.attribution.prepared, asset.prepared)
          )
            throw new Error('Storage projection terminal retirement does not match');
          for (const candidate of retirementsByReference.get(pair(path.consumer, asset.prepared.reference)) ??
            [])
            if (candidate.attribution?.assetId !== assetId)
              throw new Error('Storage projection terminal retirement attribution does not match');
          const matchingRetirements = retirementsByAsset.get(pair(path.consumer, assetId)) ?? [];
          for (const candidate of matchingRetirements) {
            if (candidate.replacementAssetId !== null)
              throw new Error('Storage projection terminal retirement has a competing replacement');
            if (
              candidate.status !== 'pending' ||
              candidate.previousReference !== asset.prepared.reference ||
              !candidate.attribution ||
              !isDeepStrictEqual(candidate.attribution.prepared, asset.prepared)
            )
              throw new Error('Storage projection terminal retirement attribution does not match');
          }
          if (matchingRetirements.length !== 1)
            throw new Error('Storage projection terminal retirement is missing or ambiguous');
          if (replacementClaims.has(pair(path.consumer, asset.prepared.reference)))
            throw new Error('Storage projection terminal retirement has a competing replacement');
          coveredRetirements.add(pair(path.terminal.operationId, path.consumer));
        }
        break;
      }
      if (hops >= path.maxHops)
        throw new Error('Storage projection survivor path exceeds its traversal limit');
      const successor = successors.get(pair(assetId, path.consumer));
      if (!successor) throw new Error('Storage projection survivor path is incomplete');
      const receipt = receipts.get(successor.operationId);
      if (
        !receipt ||
        receipt.namespace !== graph.namespace ||
        receipt.sourceAssetId !== assetId ||
        !receipt.consumers.includes(path.consumer)
      )
        throw new Error('Storage projection survivor receipt does not match');
      const destination = assets.get(receipt.destinationAssetId);
      const destinationAllocation = allocations.get(receipt.destinationAssetId);
      if (
        !destination ||
        !destinationAllocation ||
        receipt.sourceAssetId === receipt.destinationAssetId ||
        destination.prepared.operationId !== receipt.operationId
      )
        throw new Error('Storage projection relocation endpoints do not match');
      if (
        !isDeepStrictEqual(
          receipt.scopes,
          combinedScopes([...asset.prepared.scopes, ...destination.prepared.scopes]),
        ) ||
        asset.prepared.scopes.some(
          (scope) => !destination.prepared.scopes.some((candidate) => isDeepStrictEqual(candidate, scope)),
        )
      )
        throw new Error('Storage projection relocation scopes do not match');
      if (new Set(receipt.consumers).size !== receipt.consumers.length)
        throw new Error('Storage projection relocation consumers are duplicated');
      const expectedClaims = receipt.consumers.map((consumer) => ({
        consumer,
        previousReference: asset.prepared.reference,
      }));
      if (!isDeepStrictEqual(destinationAllocation.claims, expectedClaims))
        throw new Error('Storage projection relocation claims do not match');
      const retirement = retirements.get(pair(receipt.operationId, path.consumer));
      if (
        !retirement ||
        retirement.status !== 'pending' ||
        retirement.previousReference !== asset.prepared.reference ||
        retirement.replacementAssetId !== destination.id ||
        !retirement.attribution ||
        retirement.attribution.assetId !== asset.id ||
        !isDeepStrictEqual(retirement.attribution.prepared, asset.prepared)
      )
        throw new Error('Storage projection source retirement does not match');
      if (content && !isDeepStrictEqual(content, receipt.content))
        throw new Error('Storage projection survivor path content changed');
      content = receipt.content;
      coveredEdges.add(pair(receipt.operationId, path.consumer));
      coveredRetirements.add(pair(receipt.operationId, path.consumer));
      assetId = destination.id;
      hops++;
    }
    coverage.push({ path, assetIds: [...visited] });
  }
  for (const asset of graph.assets) {
    for (const consumer of asset.consumers)
      if (!liveTerminals.has(pair(asset.id, consumer)))
        throw new Error('Storage projection live owner has no survivor path');
    const allocation = allocations.get(asset.id)!;
    for (const claim of allocation.claims)
      if (!coveredAssets.has(pair(asset.id, claim.consumer)))
        throw new Error('Storage projection allocation claim has no survivor path');
  }
  for (const receipt of graph.receipts)
    for (const consumer of receipt.consumers)
      if (!coveredEdges.has(pair(receipt.operationId, consumer)))
        throw new Error('Storage projection receipt consumer has no survivor path');
  for (const retirement of graph.retirements)
    if (!coveredRetirements.has(pair(retirement.operationId, retirement.consumer)))
      throw new Error('Storage projection retirement has no survivor path');
  return coverage;
}
