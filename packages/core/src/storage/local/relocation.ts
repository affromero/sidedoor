import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { StorageReferenceRegistry } from '../registry/reference-registry';
import { StorageWriteJournal } from '../execution/write-journal';
import { sqlStateBackend, type SqlExecutor } from '../sql/sql';
import { cleanupRows } from '../cleanup/cleanup-collectors';
import { StorageCleanupJournal } from '../cleanup/cleanup-journal';
import { CleanupManifests, prepareStorageManifestPages } from '../cleanup/cleanup-manifests';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(200);
const contentSchema = z
  .object({ sha256: digest, bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();
const proofSchema = contentSchema.extend({ assetId: digest }).strict();
const scopeSchema = z
  .object({ subjectId: identity, generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();
const inputSchema = z
  .object({
    operationId: z.uuid(),
    sourceAssetId: digest,
    destinationAssetId: digest,
    consumers: z.array(identity).min(1).max(100),
    sourceRead: proofSchema,
    destinationRead: proofSchema,
  })
  .strict();
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
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
const successorSchema = z.object({ operationId: z.uuid() }).strict();
const allocationSchema = z
  .object({ schemaVersion: z.literal(1), kind: z.literal('storage_relocation_allocation') })
  .strict();
const scopeIndexSchema = scopeSchema.extend({ namespace: identity, operationId: z.uuid() }).strict();
export type StorageRelocationInput = z.infer<typeof inputSchema>;

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function combinedScopes(scopes: readonly z.infer<typeof scopeSchema>[]) {
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

/**
 * Caller-owned Serializable transactions. Only a migration copy orchestrator may
 * record receipts, after hashing source bytes and independent destination readback.
 * Supplied evidence is trusted caller testimony, not a cryptographic attestation.
 * Retain receipts and source attribution with their owning storage scopes.
 */
export class StorageRelocationRegistry {
  private readonly prefix: string;
  private readonly references: StorageReferenceRegistry;
  private readonly writes: StorageWriteJournal;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {
    this.prefix = hash(identity.parse(namespace));
    this.references = new StorageReferenceRegistry(database, dialect, namespace);
    this.writes = new StorageWriteJournal(database, dialect, namespace);
  }
  private receipt(operationId: string) {
    return sqlStateBackend(
      this.database,
      this.dialect,
      `sd-rel:1:${this.prefix}:${z.uuid().parse(operationId)}`,
    );
  }
  private allocation(operationId: string) {
    return sqlStateBackend(
      this.database,
      this.dialect,
      `sd-rel-allocation:1:${this.prefix}:${z.uuid().parse(operationId)}`,
    );
  }
  private successor(assetId: string, consumer: string) {
    return sqlStateBackend(
      this.database,
      this.dialect,
      `sd-rels:1:${this.prefix}:${hash(JSON.stringify([assetId, consumer]))}`,
    );
  }
  private scopePrefix(subjectId: string) {
    return `sd-rel-scope:1:${this.prefix}:${hash(identity.parse(subjectId))}:`;
  }
  private async remove(id: string, revision: string) {
    const parameter = (position: number) => (this.dialect === 'postgres' ? `$${position}` : '?');
    const rows = await this.database.query(
      `DELETE FROM "SidedoorState" WHERE "id" = ${parameter(1)} AND "revision" = ${parameter(2)} RETURNING "id"`,
      [id, revision],
    );
    if (rows.length !== 1) throw new Error('Storage relocation changed during erasure');
  }
  /** Retain cleanup dependencies and erase one bounded page in the caller's Serializable transaction. */
  async eraseForSubject(input: {
    subjectId: string;
    generation: number;
    jobId: string;
    epoch: number;
    after?: string | null;
  }) {
    const value = z
      .object({
        subjectId: identity,
        generation: scopeSchema.shape.generation,
        jobId: z.uuid(),
        epoch: scopeSchema.shape.generation,
        after: z.string().nullable().optional(),
      })
      .strict()
      .parse(input);
    const journal = new StorageCleanupJournal(this.database, this.dialect, this.namespace);
    const job = await journal.get(value.jobId);
    const tombstone = await this.writes.tombstone(value.subjectId);
    if (
      job.subjectId !== value.subjectId ||
      job.generation !== value.generation ||
      job.epoch !== value.epoch ||
      job.phase !== 'preparing' ||
      job.retentionPolicy !== 'job-id-snapshots-v1' ||
      tombstone?.jobId !== job.id ||
      tombstone.generation !== value.generation
    )
      throw new Error('Storage relocation erasure does not match the cleanup authority');
    const page = await this.listForSubject(value.subjectId, value.after ?? null);
    const manifests = new CleanupManifests(this.database, this.dialect, this.namespace);
    let erased = 0;
    for (const receipt of page.receipts) {
      if (
        !receipt.scopes.some(
          (scope) => scope.subjectId === value.subjectId && scope.generation === value.generation,
        )
      )
        continue;
      const allocation = await this.allocation(receipt.operationId).read();
      if (!allocation) throw new Error('Storage relocation allocation evidence is missing');
      allocationSchema.parse(allocation.state);
      const entries = [];
      for (const [role, assetId] of [
        ['source', receipt.sourceAssetId],
        ['destination', receipt.destinationAssetId],
      ] as const) {
        const asset = await this.references.readAsset(assetId);
        entries.push(
          z.json().parse({
            kind: 'storage_relocation_dependency',
            operationId: receipt.operationId,
            role,
            assetId,
            scopes: receipt.scopes,
            prepared: asset?.asset.prepared ?? null,
          }),
        );
      }
      for (const manifest of prepareStorageManifestPages(`relocation:${receipt.operationId}`, entries)) {
        await journal.recordManifestPage(job.id, job.epoch, manifest);
        const saved = await manifests.get(job, manifest.id);
        if (!isDeepStrictEqual(saved.page.entries, manifest.entries))
          throw new Error('Storage relocation cleanup dependencies do not match');
      }
      for (const scope of receipt.scopes) {
        const id = `${this.scopePrefix(scope.subjectId)}${receipt.operationId}`;
        const row = await sqlStateBackend(this.database, this.dialect, id).read();
        if (
          !row ||
          !isDeepStrictEqual(scopeIndexSchema.parse(row.state), {
            namespace: this.namespace,
            operationId: receipt.operationId,
            ...scope,
          })
        )
          throw new Error('Storage relocation scope index does not match during erasure');
        await this.remove(id, row.revision);
      }
      for (const consumer of receipt.consumers) {
        const row = await this.successor(receipt.sourceAssetId, consumer).read();
        if (row && successorSchema.parse(row.state).operationId === receipt.operationId)
          await this.remove(
            `sd-rels:1:${this.prefix}:${hash(JSON.stringify([receipt.sourceAssetId, consumer]))}`,
            row.revision,
          );
      }
      const saved = await this.receipt(receipt.operationId).read();
      if (!saved || !isDeepStrictEqual(receiptSchema.parse(saved.state), receipt))
        throw new Error('Storage relocation receipt changed during erasure');
      await this.remove(`sd-rel:1:${this.prefix}:${receipt.operationId}`, saved.revision);
      erased++;
    }
    return { erased, cursor: page.cursor };
  }
  /** Bounded discovery remains available after tombstoning for the owning erasure workflow. */
  async listForSubject(subjectId: string, after: string | null = null) {
    const prefix = this.scopePrefix(subjectId);
    const rows = await cleanupRows(this.database, this.dialect, prefix, after, 100, 'uuid');
    const receipts = [];
    for (const row of rows) {
      const index = scopeIndexSchema.parse(
        this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
      );
      if (
        index.namespace !== this.namespace ||
        index.subjectId !== subjectId ||
        row.id !== `${prefix}${index.operationId}`
      )
        throw new Error('Storage relocation scope index does not match');
      const saved = await this.receipt(index.operationId).read();
      if (!saved) throw new Error('Storage relocation scope has no receipt');
      const receipt = receiptSchema.parse(saved.state);
      if (
        receipt.namespace !== this.namespace ||
        receipt.operationId !== index.operationId ||
        !receipt.scopes.some(
          (scope) => scope.subjectId === subjectId && scope.generation === index.generation,
        )
      )
        throw new Error('Storage relocation scope attribution does not match');
      receipts.push(receipt);
    }
    return { receipts, cursor: rows.length === 100 ? String(rows.at(-1)!.id) : null };
  }
  private async validate(receipt: z.infer<typeof receiptSchema>) {
    if (
      receipt.namespace !== this.namespace ||
      receipt.sourceAssetId === receipt.destinationAssetId ||
      new Set(receipt.consumers).size !== receipt.consumers.length
    )
      throw new Error('Storage relocation identity is invalid');
    const source = await this.references.readAsset(receipt.sourceAssetId);
    const destination = await this.references.readAsset(receipt.destinationAssetId);
    if (!source || !destination || destination.asset.prepared.operationId !== receipt.operationId)
      throw new Error('Storage relocation assets do not match the operation');
    if (
      !isDeepStrictEqual(
        receipt.scopes,
        combinedScopes([...source.asset.prepared.scopes, ...destination.asset.prepared.scopes]),
      )
    )
      throw new Error('Storage relocation scope evidence does not match its assets');
    const allocation = await this.references.readAllocation(receipt.destinationAssetId);
    const claims = receipt.consumers.map((consumer) => ({
      consumer,
      previousReference: source.asset.prepared.reference,
    }));
    if (
      !allocation ||
      allocation.operationId !== receipt.operationId ||
      !isDeepStrictEqual(allocation.claims, claims)
    )
      throw new Error('Storage relocation replacement claims do not match');
    for (const scope of source.asset.prepared.scopes)
      if (!destination.asset.prepared.scopes.some((value) => isDeepStrictEqual(value, scope)))
        throw new Error('Storage relocation dropped an ownership scope');
    for (const scope of [...source.asset.prepared.scopes, ...destination.asset.prepared.scopes])
      if (await this.writes.tombstone(scope.subjectId))
        throw new Error('Storage relocation ownership was erased');
    for (const consumer of receipt.consumers) {
      const retirement = await this.references.readRetirement(receipt.operationId, consumer);
      if (
        !retirement ||
        retirement.status !== 'pending' ||
        retirement.replacementAssetId !== receipt.destinationAssetId ||
        retirement.previousReference !== source.asset.prepared.reference ||
        retirement.attribution?.assetId !== receipt.sourceAssetId ||
        !isDeepStrictEqual(retirement.attribution.prepared, source.asset.prepared)
      )
        throw new Error('Storage relocation has no exact source retirement');
    }
    return { source, destination };
  }
  async record(input: StorageRelocationInput): Promise<void> {
    const value = inputSchema.parse(input);
    value.consumers.sort();
    if (
      value.sourceRead.assetId !== value.sourceAssetId ||
      value.destinationRead.assetId !== value.destinationAssetId ||
      value.sourceRead.sha256 !== value.destinationRead.sha256 ||
      value.sourceRead.bytes !== value.destinationRead.bytes
    )
      throw new Error('Storage relocation readback does not match the captured source');
    const original = await this.references.readAsset(value.sourceAssetId);
    const replacement = await this.references.readAsset(value.destinationAssetId);
    if (!original || !replacement) throw new Error('Storage relocation assets are missing');
    const receipt = receiptSchema.parse({
      schemaVersion: 1,
      kind: 'storage_relocation',
      namespace: this.namespace,
      operationId: value.operationId,
      sourceAssetId: value.sourceAssetId,
      destinationAssetId: value.destinationAssetId,
      consumers: value.consumers,
      content: { sha256: value.sourceRead.sha256, bytes: value.sourceRead.bytes },
      scopes: combinedScopes([...original.asset.prepared.scopes, ...replacement.asset.prepared.scopes]),
    });
    const backend = this.receipt(value.operationId);
    const existing = await backend.read();
    const allocation = this.allocation(value.operationId);
    const allocated = await allocation.read();
    if (allocated) allocationSchema.parse(allocated.state);
    if (existing && !allocated) throw new Error('Storage relocation allocation evidence is missing');
    if (allocated && !existing) throw new Error('Storage relocation operation was already allocated');
    if (existing && !isDeepStrictEqual(receiptSchema.parse(existing.state), receipt))
      throw new Error('Storage relocation receipt already records different evidence');
    const { source, destination } = await this.validate(receipt);
    if (
      !existing &&
      (source.asset.consumers.length !== 0 ||
        !isDeepStrictEqual([...destination.asset.consumers].sort(), receipt.consumers))
    )
      throw new Error('Storage relocation must transfer the complete captured consumer set');
    for (const consumer of receipt.consumers) {
      const successor = this.successor(receipt.sourceAssetId, consumer);
      const row = await successor.read();
      if (row) {
        if (successorSchema.parse(row.state).operationId !== receipt.operationId)
          throw new Error('Storage relocation has a conflicting successor');
      } else if (existing) throw new Error('Storage relocation successor evidence is missing');
      else if (
        !(await successor.compareAndSwap(null, {
          revision: randomUUID(),
          state: { operationId: receipt.operationId },
        }))
      )
        throw new Error('Storage relocation successor changed concurrently');
    }
    for (const scope of receipt.scopes) {
      const indexBackend = sqlStateBackend(
        this.database,
        this.dialect,
        `${this.scopePrefix(scope.subjectId)}${receipt.operationId}`,
      );
      const index = { namespace: this.namespace, operationId: receipt.operationId, ...scope };
      const row = await indexBackend.read();
      if (row) {
        if (!isDeepStrictEqual(scopeIndexSchema.parse(row.state), index))
          throw new Error('Storage relocation scope index changed');
      } else if (existing) throw new Error('Storage relocation scope index is missing');
      else if (!(await indexBackend.compareAndSwap(null, { revision: randomUUID(), state: index })))
        throw new Error('Storage relocation scope index changed concurrently');
    }
    if (!existing && !(await backend.compareAndSwap(null, { revision: randomUUID(), state: receipt })))
      throw new Error('Storage relocation receipt changed concurrently');
    if (
      !allocated &&
      !(await allocation.compareAndSwap(null, {
        revision: randomUUID(),
        state: { schemaVersion: 1, kind: 'storage_relocation_allocation' },
      }))
    )
      throw new Error('Storage relocation allocation changed concurrently');
  }
  /** Ordinary replacements have no relocation edge and never prove equivalent content. */
  async resolve(input: {
    consumer: string;
    originalReference: string;
    currentReference: string;
    /** Explicit caller policy. Exceeding it rejects proof rather than accepting a partial chain. */
    maxHops: number;
    signal?: AbortSignal;
    /** Require this exact validated copy operation on the traversed chain. */
    requiredOperation?: { operationId: string; sourceAssetId: string; destinationAssetId: string };
  }) {
    const maxHops = z.number().int().min(1).max(10_000).parse(input.maxHops);
    const requiredOperation = inputSchema
      .pick({ operationId: true, sourceAssetId: true, destinationAssetId: true })
      .optional()
      .parse(input.requiredOperation);
    let matchedOperation = requiredOperation === undefined;
    const signal = input.signal;
    signal?.throwIfAborted();
    const consumer = identity.parse(input.consumer);
    const originalReference = z.string().min(1).parse(input.originalReference);
    const currentReference = z.string().min(1).parse(input.currentReference);
    const current = await this.references.resolve({ consumer, reference: currentReference });
    signal?.throwIfAborted();
    if (!current) return null;
    const original = await this.references.readReference(originalReference);
    signal?.throwIfAborted();
    if (!original) return null;
    let assetId = original.asset.id;
    let content: z.infer<typeof contentSchema> | null = null;
    const visited = new Set<string>();
    while (assetId !== current.assetId) {
      signal?.throwIfAborted();
      if (visited.has(assetId)) throw new Error('Storage relocation chain contains a cycle');
      if (visited.size >= maxHops)
        throw new Error('Storage relocation chain exceeds the configured traversal limit');
      visited.add(assetId);
      const successor = await this.successor(assetId, consumer).read();
      signal?.throwIfAborted();
      if (!successor) return null;
      const edge = successorSchema.parse(successor.state);
      const row = await this.receipt(edge.operationId).read();
      if (!row) throw new Error('Storage relocation receipt is missing');
      const receipt = receiptSchema.parse(row.state);
      if (
        receipt.operationId !== edge.operationId ||
        receipt.sourceAssetId !== assetId ||
        !receipt.consumers.includes(consumer)
      )
        throw new Error('Storage relocation chain identity does not match');
      await this.validate(receipt);
      if (
        requiredOperation &&
        receipt.operationId === requiredOperation.operationId &&
        receipt.sourceAssetId === requiredOperation.sourceAssetId &&
        receipt.destinationAssetId === requiredOperation.destinationAssetId
      )
        matchedOperation = true;
      if (content && !isDeepStrictEqual(content, receipt.content))
        throw new Error('Storage relocation chain content changed');
      content = receipt.content;
      assetId = receipt.destinationAssetId;
    }
    for (const scope of current.prepared.scopes)
      if (await this.writes.tombstone(scope.subjectId))
        throw new Error('Storage relocation ownership was erased');
    signal?.throwIfAborted();
    if (!matchedOperation) return null;
    return { originalAssetId: original.asset.id, current, content };
  }
}
