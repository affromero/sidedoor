import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { combinedScopes, digest, identity, scopeSchema } from '../records';
import { type SurvivorGraph, validateSurvivorPaths } from './validate-paths';

const removalSchema = z
  .object({
    assetId: digest,
    consumers: z.array(identity),
    scopes: z.array(scopeSchema),
  })
  .strict();
const requirementSchema = z
  .object({ assetId: digest, consumer: identity, scopes: z.array(scopeSchema) })
  .strict();
const retirementRemovalSchema = z.object({ operationId: z.uuid(), consumer: identity }).strict();

/**
 * Build a survivor-only graph from caller-authorized, asset-specific removals.
 * This is a read-only projection, not a write plan or authority to erase data.
 * The caller must independently establish complete discovery, associations,
 * ownership, and the scope requirements for every surviving path.
 * Empty records require coordinated erasure and are deliberately rejected here.
 */
export function projectSurvivors(input: {
  graph: SurvivorGraph;
  removals: z.input<typeof removalSchema>[];
  retirementRemovals: z.input<typeof retirementRemovalSchema>[];
  requirements: z.input<typeof requirementSchema>[];
}): SurvivorGraph {
  validateSurvivorPaths(input.graph);
  const removals = z.array(removalSchema).parse(input.removals);
  const requirements = z.array(requirementSchema).parse(input.requirements);
  const retirementRemovals = z.array(retirementRemovalSchema).parse(input.retirementRemovals);
  const byAsset = new Map<string, (typeof removals)[number]>();
  for (const removal of removals) {
    if (byAsset.has(removal.assetId)) throw new Error('Duplicate storage projection removal');
    if (new Set(removal.consumers).size !== removal.consumers.length)
      throw new Error('Duplicate storage projection consumer removal');
    if (new Set(removal.scopes.map((scope) => scope.subjectId)).size !== removal.scopes.length)
      throw new Error('Duplicate storage projection scope removal');
    const asset = input.graph.assets.find((candidate) => candidate.id === removal.assetId);
    const allocation = input.graph.allocations.find((candidate) => candidate.assetId === removal.assetId);
    if (!asset || !allocation) throw new Error('Storage projection removal asset is missing');
    if (removal.consumers.some((consumer) => !allocation.claims.some((claim) => claim.consumer === consumer)))
      throw new Error('Storage projection consumer removal is missing');
    if (removal.scopes.some((scope) => !asset.prepared.scopes.some((item) => isDeepStrictEqual(item, scope))))
      throw new Error('Storage projection scope removal is missing');
    byAsset.set(removal.assetId, removal);
  }
  const removed = (assetId: string, consumer: string) =>
    byAsset.get(assetId)?.consumers.includes(consumer) ?? false;
  const retirementKey = (operationId: string, consumer: string) => JSON.stringify([operationId, consumer]);
  const removedRetirements = new Set<string>();
  for (const removal of retirementRemovals) {
    const id = retirementKey(removal.operationId, removal.consumer);
    if (removedRetirements.has(id)) throw new Error('Duplicate storage projection retirement removal');
    const retirement = input.graph.retirements.find(
      (item) => item.operationId === removal.operationId && item.consumer === removal.consumer,
    );
    if (!retirement?.attribution || !removed(retirement.attribution.assetId, retirement.consumer))
      throw new Error('Storage projection retirement removal is not authorized for its asset');
    removedRetirements.add(id);
  }
  const graph = structuredClone(input.graph);
  graph.assets = graph.assets.map((asset) => {
    const removal = byAsset.get(asset.id);
    if (!removal) return asset;
    asset.prepared.scopes = asset.prepared.scopes.filter(
      (scope) => !removal.scopes.some((item) => isDeepStrictEqual(item, scope)),
    );
    asset.consumers = asset.consumers.filter((consumer) => !removed(asset.id, consumer));
    return asset;
  });
  const assets = new Map(graph.assets.map((asset) => [asset.id, asset]));
  graph.allocations = graph.allocations.map((allocation) => ({
    ...allocation,
    claims: allocation.claims.filter((claim) => !removed(allocation.assetId, claim.consumer)),
  }));
  graph.retirements = graph.retirements
    .filter(
      (retirement) => !removedRetirements.has(retirementKey(retirement.operationId, retirement.consumer)),
    )
    .map((retirement) => {
      if (!retirement.attribution) return retirement;
      const asset = assets.get(retirement.attribution.assetId);
      if (!asset) throw new Error('Storage projection retirement asset is missing');
      retirement.attribution.prepared = asset.prepared;
      return retirement;
    });
  graph.receipts = graph.receipts.map((receipt) => {
    const source = assets.get(receipt.sourceAssetId);
    const destination = assets.get(receipt.destinationAssetId);
    if (!source || !destination) throw new Error('Storage projection receipt asset is missing');
    const consumers = receipt.consumers.filter((consumer) => !removed(destination.id, consumer));
    const scopes = combinedScopes([...source.prepared.scopes, ...destination.prepared.scopes]);
    if (!isDeepStrictEqual(consumers, receipt.consumers) || !isDeepStrictEqual(scopes, receipt.scopes))
      return { ...receipt, schemaVersion: 2 as const, consumers, scopes };
    return receipt;
  });
  const receipts = new Map(graph.receipts.map((receipt) => [receipt.operationId, receipt]));
  graph.successors = graph.successors.filter((successor) =>
    receipts.get(successor.operationId)?.consumers.includes(successor.consumer),
  );
  graph.paths = graph.paths.filter((path) => !removed(path.originalAssetId, path.consumer));
  const coverage = validateSurvivorPaths(graph);
  const required = new Map<string, (typeof requirements)[number]>();
  const key = (assetId: string, consumer: string) => JSON.stringify([assetId, consumer]);
  for (const requirement of requirements) {
    const id = key(requirement.assetId, requirement.consumer);
    if (required.has(id)) throw new Error('Duplicate storage projection survivor requirement');
    required.set(id, requirement);
  }
  const checked = new Set<string>();
  for (const { path, assetIds } of coverage) {
    for (const assetId of assetIds) {
      const id = key(assetId, path.consumer);
      const requirement = required.get(id);
      const asset = assets.get(assetId);
      if (!requirement || !asset) throw new Error('Storage projection survivor requirement is missing');
      if (
        requirement.scopes.some(
          (scope) => !asset.prepared.scopes.some((item) => isDeepStrictEqual(item, scope)),
        )
      )
        throw new Error('Storage projection removed a required survivor scope');
      checked.add(id);
    }
  }
  if (checked.size !== required.size) throw new Error('Storage projection survivor requirement is unrelated');
  return graph;
}
