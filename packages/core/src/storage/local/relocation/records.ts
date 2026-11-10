import { createHash } from 'node:crypto';
import { z } from 'zod';

export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const identity = z.string().min(1).max(200);
/** Opaque key used to match successor inventory rows to independently discovered receipts. */
export function storageRelocationSuccessorKey(sourceAssetId: string, consumer: string) {
  return createHash('sha256')
    .update(JSON.stringify([digest.parse(sourceAssetId), identity.parse(consumer)]))
    .digest('hex');
}
export const contentSchema = z
  .object({ sha256: digest, bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();
const proofSchema = contentSchema.extend({ assetId: digest }).strict();
export const scopeSchema = z
  .object({ subjectId: identity, generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();
export const inputSchema = z
  .object({
    operationId: z.uuid(),
    sourceAssetId: digest,
    destinationAssetId: digest,
    consumers: z.array(identity).min(1).max(100),
    sourceRead: proofSchema,
    destinationRead: proofSchema,
  })
  .strict();
export const receiptSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    kind: z.literal('storage_relocation'),
    namespace: identity,
    operationId: z.uuid(),
    sourceAssetId: digest,
    destinationAssetId: digest,
    consumers: z.array(identity).min(1).max(100),
    content: contentSchema,
    scopes: z.array(scopeSchema).min(1).max(2000),
  })
  .strict();
export const successorSchema = z.object({ operationId: z.uuid() }).strict();
export const allocationSchema = z
  .object({ schemaVersion: z.literal(1), kind: z.literal('storage_relocation_allocation') })
  .strict();
export const scopeIndexSchema = scopeSchema.extend({ namespace: identity, operationId: z.uuid() }).strict();
export type StorageRelocationInput = z.infer<typeof inputSchema>;

export function combinedScopes(scopes: readonly z.infer<typeof scopeSchema>[]) {
  const values = new Map<string, number>();
  for (const scope of scopes) {
    if (values.has(scope.subjectId) && values.get(scope.subjectId) !== scope.generation)
      throw new Error('Storage relocation ownership generations conflict');
    values.set(scope.subjectId, scope.generation);
  }
  return [...values]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([subjectId, generation]) => ({ subjectId, generation }));
}
