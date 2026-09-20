import { z } from 'zod';
import { StorageCleanupJournal } from './cleanup-journal';
import { CleanupManifests } from './cleanup-manifests';
import { StorageWriteJournal } from '../execution/write-journal';
import {
  StorageReferenceRegistry,
  prepareStorageReference,
  storageSnapshotAttribution,
} from '../registry/reference-registry';
import type { SqlExecutor } from '../sql/sql';

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

/** Read-only classification of persisted cleanup evidence. Does not authorize external deletion. */
export class StorageCleanupAttribution {
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {}

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
      if (kind === 'storage_asset' || kind === 'storage_reference_retirement') {
        attribution = storageSnapshotAttribution(entry, this.namespace);
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
