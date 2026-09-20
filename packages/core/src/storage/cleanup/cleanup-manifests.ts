import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson as canonical } from '../../runtime/process/json';
import { cleanupRows } from './cleanup-collectors';
import { cleanupHash, cleanupIdentity, cleanupTargetInput, type StorageCleanupJob } from './cleanup-state';
import { sqlStateBackend, type SqlExecutor } from '../sql/sql';

const json = z.json();
type Json = z.infer<typeof json>;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MANIFEST_LIMIT_ERROR = Symbol.for('thesidedoor.storage.manifest-limit');
export class StorageManifestLimitError extends Error {
  readonly [MANIFEST_LIMIT_ERROR] = true;
  constructor() {
    super('Storage manifest exceeds its byte limit');
    this.name = 'StorageManifestLimitError';
  }
}
export function isStorageManifestLimitError(error: unknown): error is StorageManifestLimitError {
  return (
    error instanceof Error &&
    (error as Error & { [MANIFEST_LIMIT_ERROR]?: unknown })[MANIFEST_LIMIT_ERROR] === true
  );
}
const entryResolution = z.discriminatedUnion('kind', [
  z
    .object({
      index: z.number().int().min(0).max(99),
      kind: z.literal('storage'),
      targets: z.array(cleanupTargetInput).max(100),
      collectorIds: z.array(cleanupIdentity).min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      index: z.number().int().min(0).max(99),
      kind: z.literal('non_storage'),
      reason: z.string().min(1).max(1000),
    })
    .strict(),
]);
export const manifestResolution = z
  .object({
    resolver: cleanupIdentity,
    entries: z.array(entryResolution).min(1).max(100),
  })
  .strict()
  .refine(
    (resolution) =>
      resolution.entries.every(
        (entry) => entry.kind !== 'storage' || entry.targets.length + (entry.collectorIds?.length ?? 0) > 0,
      ),
    'Storage resolution needs targets or inventory collectors',
  )
  .refine(
    (resolution) =>
      resolution.entries.reduce(
        (total, entry) =>
          total + (entry.kind === 'storage' ? entry.targets.length + (entry.collectorIds?.length ?? 0) : 0),
        0,
      ) <= 1000,
    'Storage resolution exceeds its target and collector limit',
  );
export type StorageManifestResolution = z.infer<typeof manifestResolution>;
const manifestInput = z
  .object({
    id: cleanupIdentity,
    entries: z.array(json).min(1).max(100),
  })
  .strict();
export type StorageManifestInput = z.infer<typeof manifestInput>;
const manifestSchema = manifestInput.extend({
  schemaVersion: z.literal(1),
  kind: z.literal('storage_cleanup_manifest'),
  namespace: cleanupIdentity,
  jobId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  resolution: manifestResolution.nullable(),
});

function bounded(value: unknown): string {
  const encoded = canonical(json.parse(value));
  if (Buffer.byteLength(encoded) > MAX_MANIFEST_BYTES) throw new StorageManifestLimitError();
  return encoded;
}

/** Consume in the caller's snapshot transaction. A later oversized entry must roll back all pages. */
export function* prepareStorageManifestPages(
  groupId: string,
  input: Iterable<Json>,
): Generator<StorageManifestInput> {
  const group = cleanupHash(cleanupIdentity.parse(groupId));
  let entries: Json[] = [];
  let bytes = 2;
  let page = 0;
  for (const value of input) {
    const entry = structuredClone(json.parse(value));
    const size = Buffer.byteLength(canonical(entry));
    if (size + 2 > MAX_MANIFEST_BYTES) throw new StorageManifestLimitError();
    const separator = entries.length ? 1 : 0;
    if (entries.length === 100 || bytes + separator + size > MAX_MANIFEST_BYTES) {
      yield { id: `${group}:${page++}`, entries };
      entries = [];
      bytes = 2;
    }
    bytes += (entries.length ? 1 : 0) + size;
    entries.push(entry);
  }
  if (entries.length) yield { id: `${group}:${page}`, entries };
}

/** Internal immutable raw pages. The owning journal controls phases, proof records and counters. */
export class CleanupManifests {
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {}
  private prefix(job: StorageCleanupJob) {
    return `sd-m:1:${cleanupHash(this.namespace)}:${job.id}:`;
  }
  private rowId(job: StorageCleanupJob, id: string) {
    return `${this.prefix(job)}${cleanupHash(cleanupIdentity.parse(id))}`;
  }
  private backend(id: string) {
    return sqlStateBackend(this.database, this.dialect, id);
  }
  private parse(job: StorageCleanupJob, rowId: string, input: unknown) {
    const page = manifestSchema.parse(input);
    if (
      page.namespace !== this.namespace ||
      page.jobId !== job.id ||
      rowId !== this.rowId(job, page.id) ||
      page.digest !== cleanupHash(bounded(page.entries))
    )
      throw new Error('Storage manifest identity mismatch');
    if (page.resolution) this.validateResolution(page.entries.length, page.resolution);
    return page;
  }
  async get(job: StorageCleanupJob, id: string) {
    const rowId = this.rowId(job, id);
    const record = await this.backend(rowId).read();
    if (!record) throw new Error('Storage manifest is missing');
    return { page: this.parse(job, rowId, record.state), revision: record.revision };
  }
  async status(job: StorageCleanupJob, id: string): Promise<{ resolved: boolean } | null> {
    const rowId = this.rowId(job, id);
    const record = await this.backend(rowId).read();
    if (!record) return null;
    return { resolved: this.parse(job, rowId, record.state).resolution !== null };
  }
  async register(job: StorageCleanupJob, input: StorageManifestInput): Promise<boolean> {
    const page = manifestInput.parse(input);
    const encoded = bounded(page.entries);
    const rowId = this.rowId(job, page.id);
    const previous = await this.backend(rowId).read();
    if (previous) {
      const stored = this.parse(job, rowId, previous.state);
      if (bounded(stored.entries) !== encoded) throw new Error('Storage manifest payload is immutable');
      return false;
    }
    if (
      !(await this.backend(rowId).compareAndSwap(null, {
        revision: randomUUID(),
        state: {
          ...page,
          schemaVersion: 1,
          kind: 'storage_cleanup_manifest',
          namespace: this.namespace,
          jobId: job.id,
          digest: cleanupHash(encoded),
          resolution: null,
        },
      }))
    )
      throw new Error('Storage manifest changed concurrently');
    return true;
  }
  async list(job: StorageCleanupJob, after: string | null) {
    // A raw page and its resolution may each contain 1 MiB. Read one plus lookahead.
    const rows = await cleanupRows(this.database, this.dialect, this.prefix(job), after, 2);
    return {
      pages: rows
        .slice(0, 1)
        .map((row) =>
          this.parse(
            job,
            String(row.id),
            this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
          ),
        ),
      cursor: rows.length > 1 ? String(rows[0]!.id) : null,
    };
  }
  validateResolution(count: number, input: StorageManifestResolution) {
    const resolution = manifestResolution.parse(input);
    bounded(resolution);
    const indices = new Set(resolution.entries.map((entry) => entry.index));
    if (
      indices.size !== count ||
      resolution.entries.length !== count ||
      [...indices].some((index) => index >= count)
    )
      throw new Error('Storage manifest resolution must account for every entry exactly once');
    return resolution;
  }
  async resolve(job: StorageCleanupJob, id: string, input: StorageManifestResolution): Promise<boolean> {
    const { page, revision } = await this.get(job, id);
    const resolution = this.validateResolution(page.entries.length, input);
    if (page.resolution) {
      if (bounded(page.resolution) !== bounded(resolution))
        throw new Error('Storage manifest resolution is immutable');
      return false;
    }
    if (
      !(await this.backend(this.rowId(job, id)).compareAndSwap(revision, {
        revision: randomUUID(),
        state: { ...page, resolution },
      }))
    )
      throw new Error('Storage manifest changed concurrently');
    return true;
  }
}
