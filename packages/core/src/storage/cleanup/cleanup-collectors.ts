import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sqlStateBackend, sqlStateRows, type SqlExecutor } from '../sql/sql';
import { StorageBackendRegistry } from '../registry/backend-registry';
import {
  cleanupHash,
  cleanupCollector,
  cleanupCollectorRecord,
  type StorageCleanupCollector,
  type StorageCleanupCollectorRecord,
  type StorageCleanupJob,
  type StorageCleanupTargetInput,
} from './cleanup-state';

/** Bounded keyset scans use the same documented PostgreSQL text_pattern_ops index as write intents. */
export async function cleanupRows(
  database: SqlExecutor,
  dialect: 'postgres' | 'sqlite',
  prefix: string,
  after: string | null,
  limit = 100,
  cursorKind: 'digest' | 'uuid' = 'digest',
) {
  return sqlStateRows(database, dialect, prefix, after, limit, cursorKind);
}

/** Internal transaction-scoped collector records. The job owns phase and counters. */
export class CleanupCollectors {
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {}
  private prefix(jobId: string) {
    return `sd-i:1:${cleanupHash(this.namespace)}:${z.uuid().parse(jobId)}:`;
  }
  private id(jobId: string, id: string) {
    return `${this.prefix(jobId)}${cleanupHash(id)}`;
  }
  private backend(id: string) {
    return sqlStateBackend(this.database, this.dialect, id);
  }
  private registry() {
    return new StorageBackendRegistry(this.database, this.dialect, this.namespace);
  }
  private indexId(jobId: string, binding: string, prefix: string, match: 'key' | 'prefix') {
    return `sd-p:1:${cleanupHash(this.namespace)}:${z.uuid().parse(jobId)}:${cleanupHash(JSON.stringify([binding, prefix, match]))}`;
  }
  private parse(input: unknown, job: StorageCleanupJob, id: string) {
    const collector = cleanupCollectorRecord.parse(input);
    if (
      collector.namespace !== this.namespace ||
      collector.jobId !== job.id ||
      this.id(job.id, collector.id) !== id ||
      collector.verification > job.verification
    )
      throw new Error('Storage cleanup collector identity mismatch');
    if (collector.verification < job.verification && collector.kind === 'inventory') {
      collector.verification = job.verification;
      collector.cursor = null;
      collector.complete = false;
    }
    return collector;
  }
  async get(job: StorageCleanupJob, id: string) {
    const rowId = this.id(job.id, id);
    const row = await this.backend(rowId).read();
    if (!row) throw new Error('Storage cleanup collector is missing');
    return { collector: this.parse(row.state, job, rowId), revision: row.revision };
  }
  async list(job: StorageCleanupJob, after: string | null) {
    const rows = await cleanupRows(this.database, this.dialect, this.prefix(job.id), after);
    return {
      collectors: rows.map((row) =>
        this.parse(
          this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
          job,
          String(row.id),
        ),
      ),
      cursor: rows.length === 100 ? String(rows.at(-1)!.id) : null,
    };
  }
  async save(collector: StorageCleanupCollectorRecord, revision: string) {
    if (
      !(await this.backend(this.id(collector.jobId, collector.id)).compareAndSwap(revision, {
        revision: randomUUID(),
        state: cleanupCollectorRecord.parse(collector),
      }))
    )
      throw new Error('Storage cleanup collector changed concurrently');
  }
  async register(job: StorageCleanupJob, input: StorageCleanupCollector): Promise<boolean> {
    const collector = cleanupCollector.parse(input);
    const rowId = this.id(job.id, collector.id);
    const backend = this.backend(rowId);
    const previous = await backend.read();
    if (previous) {
      const stored = this.parse(previous.state, job, rowId);
      const original = {
        id: stored.id,
        kind: stored.kind,
        backendIds: stored.backendIds,
        scope: stored.scope,
        match: stored.match,
      };
      if (JSON.stringify(original) !== JSON.stringify(collector))
        throw new Error('Storage cleanup collector scope is immutable');
      return false;
    }
    for (const id of collector.backendIds) {
      const registration = await this.registry().get(id);
      if (!registration) throw new Error('Storage backend descriptor is missing');
      if (collector.kind !== 'inventory') continue;
      const indexId = this.indexId(job.id, registration.binding, collector.scope, collector.match);
      const index = this.backend(indexId);
      if (
        !(await index.read()) &&
        !(await index.compareAndSwap(null, {
          revision: randomUUID(),
          state: {
            namespace: this.namespace,
            jobId: job.id,
            binding: registration.binding,
            prefix: collector.scope,
            match: collector.match,
            collectorId: collector.id,
          },
        }))
      )
        throw new Error('Storage cleanup scope changed concurrently');
    }
    if (
      !(await backend.compareAndSwap(null, {
        revision: randomUUID(),
        state: {
          ...collector,
          namespace: this.namespace,
          jobId: job.id,
          verification: 0,
          cursor: null,
          complete: false,
        },
      }))
    )
      throw new Error('Storage cleanup collector changed concurrently');
    return true;
  }
  async covers(job: StorageCleanupJob, target: StorageCleanupTargetInput): Promise<boolean> {
    const scopes: Array<{ scope: string; match: 'key' | 'prefix' }> = [{ scope: target.key, match: 'key' }];
    // Look up exact keys and ancestor directory prefixes, never scan another subject's inventory.
    for (let index = target.key.indexOf('/'); index >= 0; index = target.key.indexOf('/', index + 1)) {
      scopes.push({ scope: target.key.slice(0, index + 1), match: 'prefix' });
    }
    for (const { scope: prefix, match } of scopes) {
      const row = await this.backend(this.indexId(job.id, target.binding, prefix, match)).read();
      if (!row) continue;
      const value = z
        .object({
          namespace: z.string(),
          jobId: z.uuid(),
          binding: z.string(),
          prefix: z.string(),
          match: z.enum(['key', 'prefix']),
          collectorId: z.string(),
        })
        .strict()
        .parse(row.state);
      if (
        value.namespace !== this.namespace ||
        value.jobId !== job.id ||
        value.binding !== target.binding ||
        value.prefix !== prefix ||
        value.match !== match
      )
        throw new Error('Storage cleanup scope identity mismatch');
      const { collector } = await this.get(job, value.collectorId);
      if (collector.kind !== 'inventory' || collector.scope !== prefix || collector.match !== match)
        throw new Error('Storage cleanup scope does not match its collector');
      for (const id of collector.backendIds) {
        if ((await this.registry().get(id))?.binding === target.binding) return true;
      }
      throw new Error('Storage cleanup scope backend does not match');
    }
    return false;
  }
}
