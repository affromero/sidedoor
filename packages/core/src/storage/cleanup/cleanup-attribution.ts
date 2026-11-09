import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../runtime/process/json';
import { StorageCleanupJournal } from './cleanup-journal';
import { CleanupManifests } from './cleanup-manifests';
import { StorageWriteJournal } from '../execution/write-journal';
import { StorageTargetFence } from '../execution/target-fence';
import { StorageRelocationRegistry } from '../local/relocation';
import {
  StorageReferenceRegistry,
  prepareStorageReference,
  storageSnapshotAttribution,
} from '../registry/reference-registry';
import { sqlStateBackend, type SqlExecutor } from '../sql/sql';

const identity = z.string().min(1).max(200);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scope = z.object({ subjectId: identity, generation }).strict();
const dependency = z
  .object({
    kind: z.literal('storage_relocation_dependency'),
    operationId: z.uuid(),
    role: z.enum(['source', 'destination']),
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    scopes: z.array(scope).min(1).max(2000),
    prepared: z.unknown(),
  })
  .strict();
const delegatedReference = z
  .object({
    kind: z.literal('storage_delegated_reference'),
    namespace: identity,
    jobId: z.uuid(),
    epoch: generation,
    subjectId: identity,
    generation,
    operationId: z.uuid(),
    consumer: identity,
    reference: z.string().min(1),
    originalScope: scope,
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    prepared: z.json(),
  })
  .strict();
const delegatedBinding = z
  .object({ kind: z.literal('storage_delegated_binding'), digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

function delegatedBindingFor(entry: z.infer<typeof delegatedReference>) {
  return {
    kind: 'storage_delegated_binding' as const,
    digest: createHash('sha256').update(canonicalJson(entry)).digest('hex'),
  };
}

/** Read-only classification of persisted cleanup evidence. Does not authorize external deletion. */
export class StorageCleanupAttribution {
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {}

  private delegatedBinding(operationId: string, consumer: string) {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    return sqlStateBackend(
      this.database,
      this.dialect,
      `sd-cda:1:${digest(this.namespace)}:${digest(JSON.stringify([operationId, consumer]))}`,
    );
  }

  /** Read-only preflight. Call within the same Serializable transaction as admission. */
  async inspectDelegatedAsset(input: {
    jobId: string;
    epoch: number;
    subjectId: string;
    generation: number;
    originalScope: { subjectId: string; generation: number };
    consumer: string;
    reference: string;
    verifyOwnership: () => Promise<boolean>;
  }) {
    const { verifyOwnership, ...raw } = input;
    const value = z
      .object({
        jobId: z.uuid(),
        epoch: generation,
        subjectId: identity,
        generation,
        originalScope: scope,
        consumer: identity,
        reference: z.string().min(1),
      })
      .strict()
      .parse(raw);
    const journal = new StorageCleanupJournal(this.database, this.dialect, this.namespace);
    const job = await journal.get(value.jobId);
    const writes = new StorageWriteJournal(this.database, this.dialect, this.namespace);
    const tombstone = await writes.tombstone(value.subjectId);
    if (
      job.namespace !== this.namespace ||
      job.epoch !== value.epoch ||
      job.subjectId !== value.subjectId ||
      job.generation !== value.generation ||
      job.phase !== 'preparing' ||
      job.retentionPolicy !== 'job-id-snapshots-v1' ||
      tombstone?.jobId !== job.id ||
      tombstone.generation !== value.generation ||
      value.originalScope.subjectId === value.subjectId
    )
      throw new Error('Delegated asset does not match cleanup authority');
    if (!(await verifyOwnership())) throw new Error('Delegated asset ownership was not verified');
    const references = new StorageReferenceRegistry(this.database, this.dialect, this.namespace);
    const resolved = await references.resolve({ consumer: value.consumer, reference: value.reference });
    if (
      !resolved ||
      !resolved.prepared.scopes.some(
        (item) =>
          item.subjectId === value.originalScope.subjectId &&
          item.generation === value.originalScope.generation,
      )
    )
      throw new Error('Delegated asset original scope does not match');
    const current = await references.readAsset(resolved.assetId);
    if (!current || current.asset.consumers.length !== 1 || current.asset.consumers[0] !== value.consumer)
      throw new Error('Delegated asset has other consumers');
    const relocations = new StorageRelocationRegistry(this.database, this.dialect, this.namespace);
    for (const captured of resolved.prepared.scopes) {
      let after: string | undefined;
      do {
        const page = await writes.list(captured.subjectId, { after });
        if (
          page.intents.some(
            (intent) =>
              intent.target.binding === resolved.prepared.target.binding &&
              intent.target.key === resolved.prepared.target.key,
          )
        )
          throw new Error('Delegated asset has retained write intents');
        after = page.cursor ?? undefined;
      } while (after);
      let cursor: string | null = null;
      do {
        const page = await relocations.listForSubject(captured.subjectId, cursor);
        if (
          page.receipts.some(
            (item) => item.sourceAssetId === resolved.assetId || item.destinationAssetId === resolved.assetId,
          )
        )
          throw new Error('Delegated asset has relocation history');
        cursor = page.cursor;
      } while (cursor);
    }
    return resolved;
  }

  /**
   * Caller fences old writers and owns a Serializable transaction. Exact retries
   * are limited to the preparing phase; later recovery uses the cleanup receipt.
   */
  async admitDelegatedAsset(
    input: Parameters<StorageCleanupAttribution['inspectDelegatedAsset']>[0] & {
      operationId: string;
    },
  ) {
    const { operationId: requestedOperationId, ...preflight } = input;
    const operationId = z.uuid().parse(requestedOperationId);
    const registry = new StorageReferenceRegistry(this.database, this.dialect, this.namespace);
    const binding = this.delegatedBinding(operationId, identity.parse(input.consumer));
    const savedBinding = await binding.read();
    const existing = await registry.readRetirement(operationId, input.consumer);
    let resolved;
    if (existing) {
      if (!savedBinding) throw new Error('Delegated asset binding is missing');
      if (
        existing.previousReference !== input.reference ||
        existing.status !== 'pending' ||
        !existing.attribution
      )
        throw new Error('Delegated asset retirement does not match');
      if (!(await input.verifyOwnership())) throw new Error('Delegated asset ownership was not verified');
      resolved = await registry.validateRetainedAttribution(existing.attribution);
    } else {
      if (savedBinding) throw new Error('Delegated asset retirement is missing');
      resolved = await this.inspectDelegatedAsset(preflight);
      await registry.retire({ operationId, consumer: input.consumer, previousReference: input.reference });
    }
    const current = await registry.readAsset(resolved.assetId);
    if (!current || current.asset.consumers.length !== 0)
      throw new Error('Delegated asset has other consumers');
    const entry = delegatedReference.parse({
      kind: 'storage_delegated_reference',
      namespace: this.namespace,
      jobId: input.jobId,
      epoch: input.epoch,
      subjectId: input.subjectId,
      generation: input.generation,
      operationId,
      consumer: input.consumer,
      reference: input.reference,
      originalScope: input.originalScope,
      assetId: resolved.assetId,
      prepared: resolved.prepared,
    });
    if (savedBinding) {
      if (!isDeepStrictEqual(delegatedBinding.parse(savedBinding.state), delegatedBindingFor(entry)))
        throw new Error('Delegated asset binding mismatch');
    } else if (
      !(await binding.compareAndSwap(null, { revision: randomUUID(), state: delegatedBindingFor(entry) }))
    ) {
      throw new Error('Delegated asset binding changed concurrently');
    }
    await new StorageTargetFence(this.database, this.dialect).retire({
      ...resolved.prepared.target,
      retirementId: operationId,
    });
    const journal = new StorageCleanupJournal(this.database, this.dialect, this.namespace);
    const collectorId = `delegated:${operationId}`;
    const pageId = `delegated:${operationId}`;
    await journal.registerCollectors(input.jobId, input.epoch, [
      {
        id: collectorId,
        kind: 'inventory',
        backendIds: [resolved.prepared.target.backendId],
        scope: resolved.prepared.target.key,
        match: 'key',
      },
    ]);
    await journal.recordManifestPage(input.jobId, input.epoch, { id: pageId, entries: [entry] });
    const inspected = await this.inspectPage({
      jobId: input.jobId,
      epoch: input.epoch,
      subjectId: input.subjectId,
      generation: input.generation,
      pageId,
    });
    const first = inspected.entries[0];
    if (!first || first.status !== 'attributed') throw new Error('Delegated asset is not attributable');
    await journal.resolveManifest(input.jobId, input.epoch, pageId, {
      resolver: 'delegated-asset-v1',
      entries: [{ index: 0, kind: 'storage', targets: [first.target], collectorIds: [collectorId] }],
    });
    return { assetId: resolved.assetId, target: first.target };
  }

  async inspectPage(input: {
    jobId: string;
    epoch: number;
    subjectId: string;
    generation: number;
    pageId: string;
  }) {
    const value = z
      .object({ jobId: z.uuid(), epoch: generation, subjectId: identity, generation, pageId: identity })
      .strict()
      .parse(input);
    const journal = new StorageCleanupJournal(this.database, this.dialect, this.namespace);
    const job = await journal.get(value.jobId);
    const tombstone = await new StorageWriteJournal(this.database, this.dialect, this.namespace).tombstone(
      value.subjectId,
    );
    if (
      job.epoch !== value.epoch ||
      job.subjectId !== value.subjectId ||
      job.generation !== value.generation ||
      job.phase !== 'preparing' ||
      job.retentionPolicy !== 'job-id-snapshots-v1' ||
      tombstone?.jobId !== job.id ||
      tombstone.generation !== value.generation
    )
      throw new Error('Storage attribution does not match cleanup authority');
    const { page } = await new CleanupManifests(this.database, this.dialect, this.namespace).get(
      job,
      value.pageId,
    );
    const references = new StorageReferenceRegistry(this.database, this.dialect, this.namespace);
    const entries = [];
    for (const [index, entry] of page.entries.entries()) {
      const kind = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.kind : undefined;
      let attribution;
      let delegated = false;
      if (kind === 'storage_asset' || kind === 'storage_reference_retirement') {
        attribution = storageSnapshotAttribution(entry, this.namespace);
      } else if (kind === 'storage_delegated_reference') {
        const saved = delegatedReference.parse(entry);
        if (
          saved.namespace !== this.namespace ||
          saved.jobId !== job.id ||
          saved.epoch !== job.epoch ||
          saved.subjectId !== job.subjectId ||
          saved.generation !== job.generation
        )
          throw new Error('Delegated asset cleanup identity mismatch');
        const binding = await this.delegatedBinding(saved.operationId, saved.consumer).read();
        if (!binding || !isDeepStrictEqual(delegatedBinding.parse(binding.state), delegatedBindingFor(saved)))
          throw new Error('Delegated asset binding mismatch');
        const retirement = await references.readRetirement(saved.operationId, saved.consumer);
        if (
          !retirement ||
          retirement.status !== 'pending' ||
          retirement.previousReference !== saved.reference ||
          !retirement.attribution ||
          retirement.attribution.assetId !== saved.assetId ||
          !isDeepStrictEqual(retirement.attribution.prepared, saved.prepared)
        )
          throw new Error('Delegated asset retirement mismatch');
        const prepared = prepareStorageReference(
          saved.prepared as Parameters<typeof prepareStorageReference>[0],
        );
        await new StorageTargetFence(this.database, this.dialect).requireRetired({
          ...prepared.target,
          retirementId: saved.operationId,
        });
        if (!prepared.scopes.some((item) => isDeepStrictEqual(item, saved.originalScope)))
          throw new Error('Delegated asset original scope mismatch');
        attribution = { assetId: saved.assetId, prepared };
        delegated = true;
      } else if (kind === 'storage_relocation_dependency') {
        const saved = dependency.parse(entry);
        if (
          !saved.scopes.some(
            (item) => item.subjectId === job.subjectId && item.generation === job.generation,
          ) ||
          new Set(saved.scopes.map((item) => item.subjectId)).size !== saved.scopes.length
        )
          throw new Error('Storage relocation dependency ownership mismatch');
        if (saved.prepared === null) {
          entries.push({ index, status: 'unresolved' as const, reason: 'missing_attribution' as const });
          continue;
        }
        const prepared = prepareStorageReference(
          saved.prepared as Parameters<typeof prepareStorageReference>[0],
        );
        if (saved.role === 'destination' && prepared.operationId !== saved.operationId)
          throw new Error('Storage relocation destination operation mismatch');
        if (
          prepared.scopes.some(
            (item) =>
              !saved.scopes.some(
                (other) => other.subjectId === item.subjectId && other.generation === item.generation,
              ),
          )
        )
          throw new Error('Storage relocation dependency scopes mismatch');
        attribution = { assetId: saved.assetId, prepared };
      } else {
        entries.push({ index, status: 'unresolved' as const, reason: 'unsupported_entry' as const });
        continue;
      }
      if (!attribution) {
        entries.push({ index, status: 'unresolved' as const, reason: 'missing_attribution' as const });
        continue;
      }
      const validated = await references.validateRetainedAttribution(attribution);
      if (
        !delegated &&
        !validated.prepared.scopes.some(
          (item) => item.subjectId === job.subjectId && item.generation === job.generation,
        )
      )
        throw new Error('Storage attribution does not belong to the cleanup subject');
      const current = await references.readAsset(validated.assetId);
      if (current?.asset.consumers.length) {
        entries.push({ index, status: 'unresolved' as const, reason: 'live_consumers' as const });
        continue;
      }
      entries.push({
        index,
        status: 'attributed' as const,
        target: validated.prepared.target,
        backend: validated.backend,
      });
    }
    return { pageId: page.id, entries };
  }
}
