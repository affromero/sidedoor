import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import {
  prepareStorageReferenceClaims,
  storageAssetSchema,
  storageReferenceAllocationSchema,
  storageReferenceAssetId,
  storageReferenceRetirementSchema,
} from '../../registry/reference-registry';
import { digest, identity, receiptSchema } from './records';

const inventorySchema = z
  .object({
    namespace: identity,
    assets: z.array(storageAssetSchema),
    allocations: z.array(storageReferenceAllocationSchema),
    retirements: z.array(storageReferenceRetirementSchema),
    receipts: z.array(receiptSchema),
    seedAssetIds: z.array(digest).min(1),
    maxAssets: z.number().int().min(1).max(1_000_000),
    maxInventoryEntries: z.number().int().min(1).max(1_000_000),
    maxInventoryUnits: z.number().int().min(1).max(50_000_000),
  })
  .strict();

/**
 * Select receipt-connected assets from a complete caller-supplied inventory.
 * Outside references and unresolved retirements are returned for independent
 * classification. The caller must drain every inventory page in the same
 * Serializable snapshot. This selection cannot detect omitted pages and does
 * not prove ownership, provenance, valid paths, or authority to change records.
 * Inventory units count values, array entries, property-name code units and
 * string code units before parsing; they are a bound, not an encoded byte size.
 * Inputs must be JSON-compatible data, not proxies or accessor-backed objects.
 */
export function selectRelocationComponent(input: z.input<typeof inventorySchema>) {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.getOwnPropertySymbols(input).length
  )
    throw new Error('Storage relocation inventory is malformed');
  if (Object.keys(input).length !== 9) throw new Error('Storage relocation inventory is malformed');
  for (const key of [
    'namespace',
    'assets',
    'allocations',
    'retirements',
    'receipts',
    'seedAssetIds',
    'maxAssets',
    'maxInventoryEntries',
    'maxInventoryUnits',
  ]) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !property.enumerable || !('value' in property))
      throw new Error('Storage relocation inventory is malformed');
  }
  const limit = z.number().int().min(1).max(1_000_000).parse(input.maxInventoryEntries);
  let units = z.number().int().min(1).max(50_000_000).parse(input.maxInventoryUnits);
  const inventories = [
    input.assets,
    input.allocations,
    input.retirements,
    input.receipts,
    input.seedAssetIds,
  ];
  if (inventories.some((items) => !Array.isArray(items)))
    throw new Error('Storage relocation inventory is malformed');
  if (inventories.reduce((total, items) => total + items.length, 0) > limit)
    throw new Error('Storage relocation inventory exceeds its entry limit');
  const pending: unknown[] = [...inventories];
  while (pending.length) {
    const item = pending.pop();
    units--;
    if (typeof item === 'string') units -= item.length;
    else if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length)
        throw new Error('Storage relocation inventory is malformed');
      units -= item.length;
      if (units < 0) throw new Error('Storage relocation inventory exceeds its data limit');
      for (let index = 0; index < item.length; index++) {
        const property = Object.getOwnPropertyDescriptor(item, index);
        if (property && !('value' in property)) throw new Error('Storage relocation inventory is malformed');
        pending.push(property?.value);
      }
    } else if (item && typeof item === 'object') {
      const prototype = Object.getPrototypeOf(item);
      if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(item).length)
        throw new Error('Storage relocation inventory is malformed');
      const record = item as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(record)) {
        units -= key.length;
        if (units < 0) throw new Error('Storage relocation inventory exceeds its data limit');
        const property = Object.getOwnPropertyDescriptor(record, key);
        if (!property || !property.enumerable || !('value' in property))
          throw new Error('Storage relocation inventory is malformed');
        pending.push(property.value);
      }
    }
    if (units < 0) throw new Error('Storage relocation inventory exceeds its data limit');
  }
  const value = inventorySchema.parse(input);
  const assets = new Map<string, (typeof value.assets)[number]>();
  const references = new Map<string, string>();
  for (const asset of value.assets) {
    if (
      asset.prepared.namespace !== value.namespace ||
      storageReferenceAssetId(asset.prepared) !== asset.id ||
      assets.has(asset.id) ||
      references.has(asset.prepared.reference)
    )
      throw new Error('Storage relocation inventory asset identity is invalid or duplicated');
    assets.set(asset.id, asset);
    references.set(asset.prepared.reference, asset.id);
  }
  const allocations = new Map<string, (typeof value.allocations)[number]>();
  for (const allocation of value.allocations) {
    if (allocation.namespace !== value.namespace || allocations.has(allocation.assetId))
      throw new Error('Storage relocation inventory allocation identity is invalid or duplicated');
    if (!isDeepStrictEqual(allocation.claims, prepareStorageReferenceClaims(allocation.claims)))
      throw new Error('Storage relocation inventory allocation claims are not canonical');
    allocations.set(allocation.assetId, allocation);
  }
  const retirementIds = new Set<string>();
  for (const retirement of value.retirements) {
    const id = JSON.stringify([retirement.operationId, retirement.consumer]);
    if (
      retirement.namespace !== value.namespace ||
      retirementIds.has(id) ||
      (retirement.attribution &&
        (retirement.attribution.prepared.namespace !== value.namespace ||
          storageReferenceAssetId(retirement.attribution.prepared) !== retirement.attribution.assetId))
    )
      throw new Error('Storage relocation inventory retirement identity is invalid or duplicated');
    retirementIds.add(id);
  }
  const edges = new Map<string, (typeof value.receipts)[number][]>();
  const receiptIds = new Set<string>();
  for (const receipt of value.receipts) {
    if (receipt.namespace !== value.namespace || receiptIds.has(receipt.operationId))
      throw new Error('Storage relocation inventory receipt identity is invalid or duplicated');
    receiptIds.add(receipt.operationId);
    for (const id of [receipt.sourceAssetId, receipt.destinationAssetId]) {
      const values = edges.get(id) ?? [];
      values.push(receipt);
      edges.set(id, values);
    }
  }
  const selectedAssets = new Set<string>();
  const selectedReceipts = new Map<string, (typeof value.receipts)[number]>();
  const queue = [...value.seedAssetIds];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (selectedAssets.has(id)) continue;
    const asset = assets.get(id);
    const allocation = allocations.get(id);
    if (!asset || !allocation || allocation.operationId !== asset.prepared.operationId)
      throw new Error('Storage relocation component asset or allocation is missing');
    selectedAssets.add(id);
    if (selectedAssets.size > value.maxAssets)
      throw new Error('Storage relocation component exceeds its asset limit');
    for (const receipt of edges.get(id) ?? []) {
      if (selectedReceipts.has(receipt.operationId)) continue;
      selectedReceipts.set(receipt.operationId, receipt);
      queue.push(receipt.sourceAssetId, receipt.destinationAssetId);
    }
  }
  const retirementsByOperation = new Map<string, (typeof value.retirements)[number][]>();
  const retirementsByReference = new Map<string, (typeof value.retirements)[number][]>();
  const retirementsByAsset = new Map<string, (typeof value.retirements)[number][]>();
  const retirementsByIdentity = new Map<string, (typeof value.retirements)[number]>();
  const allocationsByReference = new Map<string, (typeof value.allocations)[number][]>();
  const allocationsByOperation = new Map<string, (typeof value.allocations)[number][]>();
  const add = <Value>(map: Map<string, Value[]>, key: string, item: Value) => {
    const rows = map.get(key) ?? [];
    rows.push(item);
    map.set(key, rows);
  };
  for (const retirement of value.retirements) {
    add(retirementsByOperation, retirement.operationId, retirement);
    add(retirementsByReference, retirement.previousReference, retirement);
    if (retirement.attribution) add(retirementsByAsset, retirement.attribution.assetId, retirement);
    if (retirement.replacementAssetId) add(retirementsByAsset, retirement.replacementAssetId, retirement);
    retirementsByIdentity.set(JSON.stringify([retirement.operationId, retirement.consumer]), retirement);
  }
  for (const allocation of value.allocations) {
    add(allocationsByOperation, allocation.operationId, allocation);
    for (const claim of allocation.claims)
      if (claim.previousReference) add(allocationsByReference, claim.previousReference, allocation);
  }
  const relatedRetirements = new Map<string, (typeof value.retirements)[number]>();
  const outsideAssets = new Map<string, (typeof value.assets)[number]>();
  const outsideAllocations = new Map<string, (typeof value.allocations)[number]>();
  const outsideReceipts = new Map<string, (typeof value.receipts)[number]>();
  const missingOutsideAssetIds = new Set<string>();
  const unresolvedPreviousReferences = new Set<string>();
  const missingRetirementClaims = new Set<string>();
  const visitedRelatedAssets = new Set<string>();
  const visitedReferences = new Set<string>();
  const visitedOperations = new Set<string>();
  const relatedQueue: string[] = [...selectedAssets];
  const referenceQueue: string[] = [];
  const includeRetirement = (retirement: (typeof value.retirements)[number]) => {
    const id = JSON.stringify([retirement.operationId, retirement.consumer]);
    if (relatedRetirements.has(id)) return;
    relatedRetirements.set(id, retirement);
    if (retirement.replacementAssetId) relatedQueue.push(retirement.replacementAssetId);
    if (retirement.attribution) relatedQueue.push(retirement.attribution.assetId);
    referenceQueue.push(retirement.previousReference);
  };
  let assetIndex = 0;
  let referenceIndex = 0;
  while (assetIndex < relatedQueue.length || referenceIndex < referenceQueue.length) {
    if (referenceIndex < referenceQueue.length) {
      const reference = referenceQueue[referenceIndex++]!;
      if (visitedReferences.has(reference)) continue;
      visitedReferences.add(reference);
      const previous = references.get(reference);
      if (previous) relatedQueue.push(previous);
      else unresolvedPreviousReferences.add(reference);
      for (const retirement of retirementsByReference.get(reference) ?? []) includeRetirement(retirement);
      for (const next of allocationsByReference.get(reference) ?? []) relatedQueue.push(next.assetId);
      continue;
    }
    const id = relatedQueue[assetIndex++]!;
    if (visitedRelatedAssets.has(id)) continue;
    visitedRelatedAssets.add(id);
    const asset = assets.get(id);
    const allocation = allocations.get(id);
    if (asset && allocation && allocation.operationId !== asset.prepared.operationId)
      throw new Error('Storage relocation outside asset allocation does not match');
    if (asset && !selectedAssets.has(id)) outsideAssets.set(id, asset);
    if ((!allocation || !asset) && !selectedAssets.has(id)) missingOutsideAssetIds.add(id);
    if (allocation) {
      if (!selectedAssets.has(id)) outsideAllocations.set(id, allocation);
      if (!visitedOperations.has(allocation.operationId)) {
        visitedOperations.add(allocation.operationId);
        for (const retirement of retirementsByOperation.get(allocation.operationId) ?? [])
          includeRetirement(retirement);
        for (const sibling of allocationsByOperation.get(allocation.operationId) ?? [])
          relatedQueue.push(sibling.assetId);
      }
      for (const claim of allocation.claims) {
        if (!claim.previousReference) continue;
        if (
          claim.previousReference === asset?.prepared.reference ||
          (!asset &&
            (retirementsByAsset.get(id) ?? []).some(
              (retirement) =>
                retirement.attribution?.assetId === id &&
                retirement.attribution.prepared.reference === claim.previousReference,
            ))
        )
          throw new Error('Storage relocation self-reference needs independent verification');
        referenceQueue.push(claim.previousReference);
        const key = JSON.stringify([allocation.operationId, claim.consumer]);
        if (retirementsByIdentity.get(key)?.previousReference !== claim.previousReference)
          missingRetirementClaims.add(key);
      }
    }
    for (const retirement of retirementsByAsset.get(id) ?? []) includeRetirement(retirement);
    if (asset) referenceQueue.push(asset.prepared.reference);
    for (const receipt of edges.get(id) ?? []) {
      if (!selectedReceipts.has(receipt.operationId)) outsideReceipts.set(receipt.operationId, receipt);
      relatedQueue.push(receipt.sourceAssetId, receipt.destinationAssetId);
    }
  }
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  const orderedAssets = [...selectedAssets].sort(compare);
  return {
    assets: orderedAssets.map((id) => assets.get(id)!),
    allocations: orderedAssets.map((id) => allocations.get(id)!),
    retirements: [...relatedRetirements.values()].sort((left, right) =>
      compare(
        JSON.stringify([left.operationId, left.consumer]),
        JSON.stringify([right.operationId, right.consumer]),
      ),
    ),
    receipts: [...selectedReceipts.values()].sort((left, right) =>
      compare(left.operationId, right.operationId),
    ),
    outsideAssets: [...outsideAssets.values()].sort((left, right) => compare(left.id, right.id)),
    outsideAllocations: [...outsideAllocations.values()].sort((left, right) =>
      compare(left.assetId, right.assetId),
    ),
    outsideReceipts: [...outsideReceipts.values()].sort((left, right) =>
      compare(left.operationId, right.operationId),
    ),
    missingOutsideAssetIds: [...missingOutsideAssetIds].sort(compare),
    unresolvedPreviousReferences: [...unresolvedPreviousReferences].sort(compare),
    missingRetirementClaims: [...missingRetirementClaims].sort(compare).map((key) => {
      const [operationId, consumer] = JSON.parse(key) as [string, string];
      return { operationId, consumer };
    }),
  };
}
