import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { StorageCleanupJournal } from '../../../cleanup/cleanup-journal';
import { StorageTargetFence } from '../../../execution/target-fence';
import { StorageWriteJournal } from '../../../execution/write-journal';
import { StorageReferenceRegistry } from '../../../registry/reference-registry';
import { sqlStateBackend, type SqlExecutor } from '../../../sql/sql';
import { allocationSchema, identity, scopeSchema, storageRelocationSuccessorKey } from '../records';
import { projectSurvivors } from './project-survivors';
import type { SurvivorGraph } from './validate-paths';

const authoritySchema = scopeSchema
  .extend({ jobId: z.uuid(), epoch: z.number().int().nonnegative() })
  .strict();

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Apply a projection in a caller-owned Serializable transaction. The caller must
 * roll back the entire transaction on any error. verifyApplication must establish
 * complete discovery, ownership, associations, copy provenance, replacement
 * boundaries, lifecycle fences and later-erasure evidence from authoritative
 * state in this same transaction. For each removed consumer it must prove the
 * precise association with an authorized deleted scope. It must also prove
 * the original copy operations are settled and drained: their original claims
 * are no longer replayable after personal data is removed. The callback must
 * only read the database and must not perform external I/O.
 */
export async function writeSurvivorProjection(input: {
  database: SqlExecutor;
  dialect: 'postgres' | 'sqlite';
  projection: Parameters<typeof projectSurvivors>[0];
  authorities: z.input<typeof authoritySchema>[];
  verifyApplication: (original: SurvivorGraph, projected: SurvivorGraph) => Promise<boolean>;
}) {
  const { database, dialect } = input;
  const { graph, removals, retirementRemovals, requirements } = input.projection;
  const projection = structuredClone({ graph, removals, retirementRemovals, requirements });
  const original = projection.graph;
  const namespace = identity.parse(original.namespace);
  const prefix = hash(namespace);
  const projected = projectSurvivors(projection);
  if (!(await input.verifyApplication(structuredClone(original), structuredClone(projected))))
    throw new Error('Storage projection application evidence was not verified');
  const authorities = z.array(authoritySchema).min(1).parse(input.authorities);
  const jobs = new StorageCleanupJournal(database, dialect, namespace);
  const writes = new StorageWriteJournal(database, dialect, namespace);
  const checkedScopes = new Set<string>();
  for (const authority of authorities) {
    if (checkedScopes.has(authority.subjectId)) throw new Error('Duplicate storage projection authority');
    const job = await jobs.get(authority.jobId);
    const tombstone = await writes.tombstone(authority.subjectId);
    if (
      job.subjectId !== authority.subjectId ||
      job.generation !== authority.generation ||
      job.epoch !== authority.epoch ||
      job.phase !== 'preparing' ||
      job.retentionPolicy !== 'job-id-snapshots-v1' ||
      tombstone?.jobId !== job.id ||
      tombstone.generation !== authority.generation
    )
      throw new Error('Storage projection cleanup authority does not match');
    checkedScopes.add(authority.subjectId);
  }
  for (const removal of projection.removals) {
    if (removal.consumers.length && !removal.scopes.length)
      throw new Error('Storage projection consumer removal has no cleanup scope');
    for (const scope of removal.scopes)
      if (
        !authorities.some(
          (authority) => authority.subjectId === scope.subjectId && authority.generation === scope.generation,
        )
      )
        throw new Error('Storage projection scope has no cleanup authority');
  }
  for (const asset of projected.assets)
    for (const scope of asset.prepared.scopes)
      if (await writes.tombstone(scope.subjectId))
        throw new Error('Storage projection survivor ownership was erased');

  const targetFence = new StorageTargetFence(database, dialect);
  const targets = new Map(original.assets.map((asset) => [asset.id, asset.prepared.target]));
  for (const [, target] of [...targets].sort(([left], [right]) => left.localeCompare(right)))
    await targetFence.admit(target);

  const registry = new StorageReferenceRegistry(database, dialect, namespace);
  for (const asset of original.assets) {
    const reference = await registry.readReference(asset.prepared.reference);
    if (!reference || !isDeepStrictEqual(reference.asset, asset))
      throw new Error('Storage projection reference attribution changed');
  }

  const changes: { id: string; revision: string; previous: unknown; next: unknown | null }[] = [];
  const capture = async (id: string, previous: unknown, next: unknown | null) => {
    const row = await sqlStateBackend(database, dialect, id).read();
    if (!row || !isDeepStrictEqual(row.state, previous))
      throw new Error('Storage projection evidence changed');
    changes.push({ id, revision: row.revision, previous, next });
  };
  const byId = <T>(items: T[], id: (item: T) => string) => new Map(items.map((item) => [id(item), item]));
  const assets = byId(projected.assets, (item) => item.id);
  const allocations = byId(projected.allocations, (item) => item.assetId);
  const retirementId = (item: { operationId: string; consumer: string }) =>
    hash(JSON.stringify([item.operationId, item.consumer]));
  const retirements = byId(projected.retirements, retirementId);
  const receipts = byId(projected.receipts, (item) => item.operationId);
  for (const asset of original.assets)
    await capture(`sd-asset:1:${prefix}:${asset.id}`, asset, assets.get(asset.id) ?? null);
  for (const allocation of original.allocations)
    await capture(
      `sd-allocation:1:${prefix}:${allocation.assetId}`,
      allocation,
      allocations.get(allocation.assetId) ?? null,
    );
  for (const retirement of original.retirements)
    await capture(
      `sd-retired:1:${prefix}:${retirementId(retirement)}`,
      retirement,
      retirements.get(retirementId(retirement)) ?? null,
    );
  for (const receipt of original.receipts) {
    const next = receipts.get(receipt.operationId);
    if (!next) throw new Error('Storage projection receipt cannot be empty');
    await capture(`sd-rel:1:${prefix}:${receipt.operationId}`, receipt, next);
    const markerId = `sd-rel-allocation:1:${prefix}:${receipt.operationId}`;
    const marker = await sqlStateBackend(database, dialect, markerId).read();
    if (!marker) throw new Error('Storage projection operation marker is missing');
    allocationSchema.parse(marker.state);
    for (const scope of receipt.scopes) {
      const index = { namespace, operationId: receipt.operationId, ...scope };
      const retained = next.scopes.some((item) => isDeepStrictEqual(item, scope));
      await capture(
        `sd-rel-scope:1:${prefix}:${hash(scope.subjectId)}:${receipt.operationId}`,
        index,
        retained ? index : null,
      );
    }
    for (const consumer of receipt.consumers) {
      const id = `sd-rels:1:${prefix}:${storageRelocationSuccessorKey(receipt.sourceAssetId, consumer)}`;
      const successor = { operationId: receipt.operationId };
      await capture(id, successor, next.consumers.includes(consumer) ? successor : null);
    }
  }
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.id)) throw new Error('Duplicate storage projection state record');
    seen.add(change.id);
  }
  for (const change of changes.sort((left, right) => left.id.localeCompare(right.id))) {
    if (isDeepStrictEqual(change.previous, change.next)) continue;
    if (change.next === null) {
      const parameter = (position: number) => (dialect === 'postgres' ? `$${position}` : '?');
      const rows = await database.query(
        `DELETE FROM "SidedoorState" WHERE "id" = ${parameter(1)} AND "revision" = ${parameter(2)} RETURNING "id"`,
        [change.id, change.revision],
      );
      if (rows.length !== 1) throw new Error('Storage projection evidence changed concurrently');
    } else if (
      !(await sqlStateBackend(database, dialect, change.id).compareAndSwap(change.revision, {
        revision: randomUUID(),
        state: change.next,
      }))
    )
      throw new Error('Storage projection evidence changed concurrently');
  }
  return projected;
}
