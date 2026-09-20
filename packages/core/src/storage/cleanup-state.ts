import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateStorageKey } from './references';

export const cleanupIdentity = z.string().min(1).max(200);
export const cleanupDigest = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const cleanupTargetInput = z
  .object({
    backendId: cleanupDigest,
    binding: cleanupDigest,
    key: z.string().transform((key) => {
      // Object directory markers are distinct exact keys. Local executors reject them.
      validateStorageKey(key.endsWith('/') ? key.slice(0, -1) : key);
      return key;
    }),
  })
  .strict();
export const cleanupCollector = z
  .object({
    id: cleanupIdentity,
    kind: z.enum(['references', 'inventory']),
    backendIds: z.array(cleanupDigest).min(1).max(128),
    scope: z.string().min(1).max(2000),
    match: z.enum(['prefix', 'key']).default('prefix'),
  })
  .strict()
  .refine((value) => new Set(value.backendIds).size === value.backendIds.length)
  .refine((value) => {
    if (value.kind === 'references') return true;
    if (value.match === 'prefix' && !value.scope.endsWith('/')) return false;
    try {
      validateStorageKey(value.scope.endsWith('/') ? value.scope.slice(0, -1) : value.scope);
      return true;
    } catch {
      return false;
    }
  }, 'Inventory requires an exact directory prefix');
export const cleanupCollectorRecord = cleanupCollector.safeExtend({
  namespace: cleanupIdentity,
  jobId: z.uuid(),
  verification: counter,
  cursor: z.string().max(8192).nullable(),
  complete: z.boolean(),
});
export type StorageCleanupCollector = z.input<typeof cleanupCollector>;
export type StorageCleanupCollectorRecord = z.infer<typeof cleanupCollectorRecord>;
export const cleanupJob = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('storage_cleanup'),
    namespace: cleanupIdentity,
    subjectId: cleanupIdentity,
    generation: counter,
    id: z.uuid(),
    createdAt: counter,
    epoch: counter,
    phase: z.enum(['preparing', 'waiting', 'collecting', 'ready', 'deleting', 'verifying', 'complete']),
    drainCursor: z.string().nullable(),
    pending: counter,
    deleted: counter,
    verification: counter,
    collectorCount: counter,
    inventoryCount: counter,
    remainingCollectors: counter,
    manifestCount: counter.default(0),
    unresolvedManifests: counter.default(0),
    retentionPolicy: z.literal('job-id-snapshots-v1').optional(),
  })
  .strict();
export const cleanupTarget = z
  .object({
    schemaVersion: z.literal(1),
    namespace: cleanupIdentity,
    jobId: z.uuid(),
    id: cleanupDigest,
    binding: cleanupDigest,
    key: cleanupTargetInput.shape.key,
    backendIds: z.array(cleanupDigest).min(1).max(128),
    status: z.enum(['pending', 'deleted']),
  })
  .strict()
  .refine((value) => new Set(value.backendIds).size === value.backendIds.length);
export type StorageCleanupJob = z.infer<typeof cleanupJob>;
export type StorageCleanupTarget = z.infer<typeof cleanupTarget>;
export type StorageCleanupTargetInput = z.infer<typeof cleanupTargetInput>;
export interface StorageDeletionTicket {
  jobId: string;
  epoch: number;
  target: StorageCleanupTarget;
  revision: string;
}
export function cleanupHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Prepare once before retrying the caller's transaction. Scopes must remain immutable. */
export function prepareStorageCleanup(input: {
  namespace: string;
  subjectId: string;
  generation: number;
  retentionPolicy?: 'job-id-snapshots-v1';
}): StorageCleanupJob {
  return cleanupJob.parse({
    ...input,
    schemaVersion: 1,
    kind: 'storage_cleanup',
    id: randomUUID(),
    createdAt: Date.now(),
    epoch: 0,
    phase: 'preparing',
    drainCursor: null,
    pending: 0,
    deleted: 0,
    verification: 0,
    collectorCount: 0,
    inventoryCount: 0,
    remainingCollectors: 0,
  });
}
