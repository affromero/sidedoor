import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { StorageBackendRegistry } from './backend-registry';
import { cleanupRows } from './cleanup-collectors';
import { sqlStateBackend, type SqlExecutor } from './sql';
import { normalizeStorageReference, validateStorageKey } from './references';

const identity = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const claimsSchema = z
  .array(z.object({ consumer: identity, previousReference: z.string().min(1).nullable() }).strict())
  .min(1)
  .max(100);
const allocationSchema = z
  .object({
    kind: z.literal('storage_reference_allocation'),
    namespace: identity,
    operationId: z.uuid(),
    assetId: digest,
    claims: claimsSchema,
  })
  .strict();
const referenceSchema = z
  .object({
    namespace: identity,
    operationId: z.uuid(),
    reference: z.string().min(1),
    localRoutePrefix: z.string().min(1).optional(),
    target: z
      .object({ backendId: digest, binding: digest, key: z.string().transform(validateStorageKey) })
      .strict(),
    scopes: z
      .array(z.object({ subjectId: identity, generation: z.number().int().nonnegative() }).strict())
      .min(1),
  })
  .strict();
export type PreparedStorageReference = z.infer<typeof referenceSchema>;
/** Valid attribution exists, but the requested application consumer does not own it. */
export class StorageReferenceConsumerMismatchError extends Error {
  constructor() {
    super('Storage reference does not belong to this consumer');
    this.name = 'StorageReferenceConsumerMismatchError';
  }
}
const assetSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('storage_asset'),
    id: digest,
    prepared: referenceSchema,
    consumers: z.array(identity),
  })
  .strict();
const aliasSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('storage_reference_alias'),
    namespace: identity,
    reference: z.string().min(1),
    assetId: digest,
  })
  .strict();
const retirementSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('storage_reference_retirement'),
    namespace: identity,
    operationId: z.uuid(),
    consumer: identity,
    previousReference: z.string().min(1),
    replacementAssetId: digest.nullable(),
    attribution: z.object({ assetId: digest, prepared: referenceSchema }).strict().nullable(),
    status: z.enum(['pending', 'unresolved']),
  })
  .strict();

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function assetId(prepared: PreparedStorageReference): string {
  return hash(JSON.stringify([prepared.target.binding, prepared.target.key]));
}

/** Parse canonical cleanup snapshots using the same schemas as the retained registry. */
export function storageSnapshotAttribution(input: unknown, namespace: string) {
  const kind = z.object({ kind: z.string() }).passthrough().parse(input).kind;
  if (kind === 'storage_asset') {
    const asset = assetSchema.parse(input);
    return { assetId: asset.id, prepared: asset.prepared };
  }
  if (kind === 'storage_reference_retirement') {
    const retirement = retirementSchema.parse(input);
    if (retirement.namespace !== namespace) throw new Error('Storage retirement namespace mismatch');
    return retirement.attribution;
  }
  throw new Error('Unsupported storage reference snapshot');
}

/** Prepare once outside transaction retries, after the writer returns its captured reference. */
export function prepareStorageReference(input: PreparedStorageReference): PreparedStorageReference {
  return referenceSchema.parse(input);
}

/** Capture the complete immutable consumer claims before storage I/O begins. */
export function prepareStorageReferenceClaims(
  input: ReadonlyArray<{ consumer: string; previousReference: string | null }>,
) {
  const claims = claimsSchema
    .parse(input)
    .sort((left, right) => (left.consumer < right.consumer ? -1 : left.consumer > right.consumer ? 1 : 0));
  if (new Set(claims.map((value) => value.consumer)).size !== claims.length)
    throw new Error('Storage consumers must be distinct');
  return claims;
}

/**
 * All operations belong to the caller's Serializable reference transaction.
 * Retirement preserves attribution, it never grants permission to delete bytes.
 * Cleanup must validate every current consumer and erasure scope before deleting.
 */
export class StorageReferenceRegistry {
  private readonly prefix: string;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {
    identity.parse(namespace);
    this.prefix = hash(namespace);
  }
  private backend(kind: string, id: string) {
    return sqlStateBackend(this.database, this.dialect, `sd-${kind}:1:${this.prefix}:${id}`);
  }
  private validate(input: PreparedStorageReference) {
    const prepared = referenceSchema.parse(input);
    if (prepared.namespace !== this.namespace) throw new Error('Storage reference namespace mismatch');
    return prepared;
  }

  /** Validate captured cleanup attribution even after its asset row was erased. No access grant. */
  async validateRetainedAttribution(input: { assetId: string; prepared: PreparedStorageReference }) {
    const id = digest.parse(input.assetId);
    const prepared = this.validate(input.prepared);
    if (assetId(prepared) !== id) throw new Error('Storage retained attribution identity mismatch');
    const backend = await this.validateBackend(prepared);
    return structuredClone({ assetId: id, prepared, backend });
  }

  /** Retained attribution remains readable after the last application consumer retires. */
  async readAsset(id: string) {
    digest.parse(id);
    const row = await this.backend('asset', id).read();
    if (!row) return null;
    const asset = assetSchema.parse(row.state);
    this.validate(asset.prepared);
    if (asset.id !== id || assetId(asset.prepared) !== id) throw new Error('Storage asset identity mismatch');
    const backend = await this.validateBackend(asset.prepared);
    return structuredClone({ asset, backend });
  }

  /** Historical lookup does not grant current consumer ownership or application access. */
  async readReference(reference: string) {
    z.string().min(1).parse(reference);
    const attributed = await this.attributed(reference);
    if (!attributed) return null;
    const backend = await this.validateBackend(attributed.asset.prepared);
    return structuredClone({ asset: attributed.asset, backend });
  }

  /** Immutable claims captured by the original replacement transaction. */
  async readAllocation(id: string) {
    digest.parse(id);
    const row = await this.backend('allocation', id).read();
    if (!row) return null;
    const allocation = allocationSchema.parse(row.state);
    if (allocation.namespace !== this.namespace || allocation.assetId !== id)
      throw new Error('Storage allocation identity mismatch');
    prepareStorageReferenceClaims(allocation.claims);
    return structuredClone(allocation);
  }

  /** Exact replacement evidence. Unknown historical ownership stays explicitly unresolved. */
  async readRetirement(operationId: string, consumer: string) {
    z.uuid().parse(operationId);
    identity.parse(consumer);
    const row = await this.backend('retired', hash(JSON.stringify([operationId, consumer]))).read();
    if (!row) return null;
    const retirement = retirementSchema.parse(row.state);
    if (
      retirement.namespace !== this.namespace ||
      retirement.operationId !== operationId ||
      retirement.consumer !== consumer
    )
      throw new Error('Storage retirement identity mismatch');
    if (retirement.attribution) {
      this.validate(retirement.attribution.prepared);
      if (assetId(retirement.attribution.prepared) !== retirement.attribution.assetId)
        throw new Error('Storage retirement attribution mismatch');
    }
    return structuredClone(retirement);
  }

  /**
   * Scan every page in the caller's Serializable snapshot before removing application rows.
   * Empty consumer lists remain discoverable: retirement does not erase asset ownership scopes.
   * The application determines which scopes belong to its deletion operation.
   */
  async listAssets(after: string | null = null) {
    const prefix = `sd-asset:1:${this.prefix}:`;
    const rows = await cleanupRows(this.database, this.dialect, prefix, after);
    const assets = rows.map((row) => {
      const asset = assetSchema.parse(this.decode(row.state));
      this.validate(asset.prepared);
      if (asset.id !== assetId(asset.prepared) || row.id !== `${prefix}${asset.id}`)
        throw new Error('Storage asset identity mismatch');
      return asset;
    });
    return { assets, cursor: rows.length === 100 ? String(rows.at(-1)!.id) : null };
  }

  /** Includes unresolved references with no asset row. Consumer ownership is application-defined. */
  async listRetirements(after: string | null = null) {
    const prefix = `sd-retired:1:${this.prefix}:`;
    const rows = await cleanupRows(this.database, this.dialect, prefix, after);
    const retirements = rows.map((row) => {
      const retirement = retirementSchema.parse(this.decode(row.state));
      const id = hash(JSON.stringify([retirement.operationId, retirement.consumer]));
      if (retirement.namespace !== this.namespace || row.id !== `${prefix}${id}`)
        throw new Error('Storage retirement identity mismatch');
      if (retirement.attribution) {
        this.validate(retirement.attribution.prepared);
        if (retirement.attribution.assetId !== assetId(retirement.attribution.prepared))
          throw new Error('Storage retirement attribution mismatch');
      }
      return retirement;
    });
    return { retirements, cursor: rows.length === 100 ? String(rows.at(-1)!.id) : null };
  }

  private decode(state: unknown): unknown {
    return this.dialect === 'sqlite' && typeof state === 'string' ? JSON.parse(state) : state;
  }
  private async attributed(reference: string) {
    const alias = await this.backend('alias', hash(reference)).read();
    if (!alias) return null;
    const value = aliasSchema.parse(alias.state);
    if (value.namespace !== this.namespace || value.reference !== reference)
      throw new Error('Storage reference alias mismatch');
    const record = await this.backend('asset', value.assetId).read();
    if (!record) throw new Error('Storage reference attribution is missing');
    const asset = assetSchema.parse(record.state);
    this.validate(asset.prepared);
    if (asset.id !== value.assetId || assetId(asset.prepared) !== asset.id)
      throw new Error('Storage asset identity mismatch');
    return { record, asset };
  }

  async replace(input: {
    consumer: string;
    previousReference: string | null;
    next: PreparedStorageReference;
  }): Promise<void> {
    return this.replaceMany({
      consumers: [{ consumer: input.consumer, previousReference: input.previousReference }],
      next: input.next,
    });
  }

  /** Resolve current consumer attribution in the caller's Serializable snapshot.
   * Unknown references require explicit adoption. This never grants application access.
   */
  async resolve(input: { consumer: string; reference: string }) {
    const consumer = identity.parse(input.consumer);
    const reference = z.string().min(1).parse(input.reference);
    const attributed = await this.attributed(reference);
    if (!attributed) return null;
    const { asset } = attributed;
    const backend = await this.validateBackend(asset.prepared);
    if (!asset.consumers.includes(consumer)) throw new StorageReferenceConsumerMismatchError();
    return structuredClone({ assetId: asset.id, prepared: asset.prepared, backend });
  }

  private async validateBackend(next: PreparedStorageReference) {
    const registered = await new StorageBackendRegistry(this.database, this.dialect, this.namespace).get(
      next.target.backendId,
    );
    if (!registered || registered.binding !== next.target.binding)
      throw new Error('Storage reference backend is missing');
    const descriptor = registered.descriptor;
    const key =
      descriptor.kind === 'local'
        ? normalizeStorageReference({ kind: 'local', root: descriptor.referenceRoot }, next.reference, {
            localRoutePrefix: next.localRoutePrefix,
          })
        : normalizeStorageReference(descriptor.location, next.reference, {
            ...(descriptor.publicUrl ? { publicUrl: descriptor.publicUrl } : {}),
            publicUrlEncoding: descriptor.referenceEncoding,
          });
    if (key !== next.target.key) throw new Error('Storage reference does not address its attributed key');
    return registered;
  }

  /** Allocate one immutable asset for all of its application references in the caller's transaction. */
  async replaceMany(input: {
    consumers: ReadonlyArray<{ consumer: string; previousReference: string | null }>;
    next: PreparedStorageReference;
  }): Promise<void> {
    const replacements = prepareStorageReferenceClaims(input.consumers);
    const consumers = replacements.map((value) => value.consumer).sort();
    const next = this.validate(input.next);
    await this.validateBackend(next);
    const id = assetId(next);
    const assetBackend = this.backend('asset', id);
    const previousAsset = await assetBackend.read();
    const allocationBackend = this.backend('allocation', id);
    const allocation = allocationSchema.parse({
      kind: 'storage_reference_allocation',
      namespace: this.namespace,
      operationId: next.operationId,
      assetId: id,
      claims: replacements,
    });
    const priorAllocation = await allocationBackend.read();
    if (priorAllocation) {
      if (!isDeepStrictEqual(allocationSchema.parse(priorAllocation.state), allocation))
        throw new Error('Storage allocation replacement claims changed');
    } else {
      if (previousAsset) throw new Error('Storage allocation replacement claims are missing');
      if (!(await allocationBackend.compareAndSwap(null, { revision: randomUUID(), state: allocation })))
        throw new Error('Storage allocation claims changed concurrently');
    }
    if (previousAsset) {
      const existing = assetSchema.parse(previousAsset.state);
      if (
        !isDeepStrictEqual(existing.prepared, next) ||
        !isDeepStrictEqual([...existing.consumers].sort(), consumers)
      )
        throw new Error('Storage asset allocation is already in use');
    } else if (
      !(await assetBackend.compareAndSwap(null, {
        revision: randomUUID(),
        state: assetSchema.parse({
          schemaVersion: 1,
          kind: 'storage_asset',
          id,
          prepared: next,
          consumers,
        }),
      }))
    )
      throw new Error('Storage asset allocation changed concurrently');

    const aliasBackend = this.backend('alias', hash(next.reference));
    const previousAlias = await aliasBackend.read();
    const alias = aliasSchema.parse({
      schemaVersion: 1,
      kind: 'storage_reference_alias',
      namespace: this.namespace,
      reference: next.reference,
      assetId: id,
    });
    if (previousAlias) {
      if (JSON.stringify(aliasSchema.parse(previousAlias.state)) !== JSON.stringify(alias))
        throw new Error('Storage reference alias is already in use');
    } else if (!(await aliasBackend.compareAndSwap(null, { revision: randomUUID(), state: alias })))
      throw new Error('Storage reference alias changed concurrently');

    for (const replacement of replacements) {
      if (replacement.previousReference === null || replacement.previousReference === next.reference)
        continue;
      await this.retireReference({
        operationId: next.operationId,
        consumer: replacement.consumer,
        previousReference: replacement.previousReference,
        replacementAssetId: id,
      });
    }
  }

  /** Commit with removal of the application's reference, including selection of a bundled asset. */
  async retire(input: { operationId: string; consumer: string; previousReference: string }): Promise<void> {
    await this.retireReference({
      operationId: z.uuid().parse(input.operationId),
      consumer: identity.parse(input.consumer),
      previousReference: z.string().min(1).parse(input.previousReference),
      replacementAssetId: null,
    });
  }

  private async retireReference(input: {
    operationId: string;
    consumer: string;
    previousReference: string;
    replacementAssetId: string | null;
  }): Promise<void> {
    const { consumer } = input;
    const prior = await this.attributed(input.previousReference);
    const owned = prior?.asset.consumers.includes(consumer) ? prior : null;
    const retirement = retirementSchema.parse({
      schemaVersion: 1,
      kind: 'storage_reference_retirement',
      namespace: this.namespace,
      operationId: input.operationId,
      consumer,
      previousReference: input.previousReference,
      replacementAssetId: input.replacementAssetId,
      attribution: owned ? { assetId: owned.asset.id, prepared: owned.asset.prepared } : null,
      status: owned ? 'pending' : 'unresolved',
    });
    const retirementBackend = this.backend('retired', hash(JSON.stringify([input.operationId, consumer])));
    const existingRetirement = await retirementBackend.read();
    if (existingRetirement) {
      // A committed retry must not reinterpret removed consumer membership as unknown attribution.
      const existing = retirementSchema.parse(existingRetirement.state);
      if (
        existing.namespace !== this.namespace ||
        existing.operationId !== input.operationId ||
        existing.consumer !== consumer ||
        existing.previousReference !== input.previousReference ||
        existing.replacementAssetId !== input.replacementAssetId
      )
        throw new Error('Storage retirement identity mismatch');
      return;
    }
    if (owned) {
      const updated = {
        ...owned.asset,
        consumers: owned.asset.consumers.filter((value) => value !== consumer),
      };
      if (
        !(await this.backend('asset', owned.asset.id).compareAndSwap(owned.record.revision, {
          revision: randomUUID(),
          state: updated,
        }))
      )
        throw new Error('Storage reference ownership changed concurrently');
    }
    if (!(await retirementBackend.compareAndSwap(null, { revision: randomUUID(), state: retirement })))
      throw new Error('Storage retirement changed concurrently');
  }
}
