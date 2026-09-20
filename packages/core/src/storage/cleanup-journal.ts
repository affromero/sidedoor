import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageBackendRegistry } from './backend-registry';
import { StorageWriteJournal } from './write-journal';
import { CleanupCollectors, cleanupRows } from './cleanup-collectors';
import {
  CleanupManifests,
  type StorageManifestInput,
  type StorageManifestResolution,
} from './cleanup-manifests';
import { sqlStateBackend, type SqlExecutor } from './sql';
import { retentionBackend, retentionBinding, retentionStateSchema } from '../runtime/retention-state';
import { JobRetentionCleanup } from '../runtime/retention';
import {
  cleanupHash,
  cleanupIdentity,
  cleanupJob,
  cleanupTarget,
  cleanupTargetInput,
  type StorageCleanupJob,
  type StorageCleanupCollector,
  type StorageCleanupTarget,
  type StorageCleanupTargetInput,
  type StorageDeletionTicket,
} from './cleanup-state';

/**
 * Every call belongs to a caller-owned Serializable transaction. This journal never runs I/O.
 * Workers must serialize discovery/deletion on a pinned, dedicated backend lock connection.
 * Lock loss stops new I/O. Immutable, never-reused keys and excluded writers make an older
 * outstanding delete safe. Reference creation must share this exclusion protocol.
 */
export class StorageCleanupJournal {
  private readonly namespaceHash: string;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {
    cleanupIdentity.parse(namespace);
    this.namespaceHash = cleanupHash(namespace);
  }
  private jobId(id: string): string {
    return `sd-c:1:${this.namespaceHash}:${z.uuid().parse(id)}`;
  }
  private targetPrefix(jobId: string): string {
    return `sd-d:1:${this.namespaceHash}:${z.uuid().parse(jobId)}:`;
  }
  private targetId(target: Pick<StorageCleanupTarget, 'jobId' | 'id'>): string {
    return `${this.targetPrefix(target.jobId)}${target.id}`;
  }
  private backend(id: string) {
    return sqlStateBackend(this.database, this.dialect, id);
  }
  private async readOptional(id: string) {
    const record = await this.backend(this.jobId(id)).read();
    if (!record) return null;
    const job = cleanupJob.parse(record.state);
    if (job.namespace !== this.namespace || job.id !== id)
      throw new Error('Storage cleanup job identity mismatch');
    return { job, revision: record.revision };
  }
  private async read(id: string, epoch?: number) {
    const record = await this.readOptional(id);
    if (!record) throw new Error('Storage cleanup job is missing');
    if (epoch !== undefined && epoch !== record.job.epoch) throw new Error('Storage cleanup phase changed');
    return record;
  }
  private async save(job: StorageCleanupJob, revision: string): Promise<void> {
    const state = cleanupJob.parse(job);
    if (
      !(await this.backend(this.jobId(state.id)).compareAndSwap(revision, { revision: randomUUID(), state }))
    )
      throw new Error('Storage cleanup changed concurrently');
  }
  private collectors() {
    return new CleanupCollectors(this.database, this.dialect, this.namespace);
  }
  private manifests() {
    return new CleanupManifests(this.database, this.dialect, this.namespace);
  }
  private registry() {
    return new StorageBackendRegistry(this.database, this.dialect, this.namespace);
  }
  private writes() {
    return new StorageWriteJournal(this.database, this.dialect, this.namespace);
  }
  private async validateBackend(target: StorageCleanupTargetInput): Promise<void> {
    const backend = await this.registry().get(target.backendId);
    if (!backend || backend.binding !== target.binding)
      throw new Error('Storage cleanup target backend does not match');
    if (backend.descriptor.kind === 'local' && target.key.endsWith('/'))
      throw new Error('Local cleanup cannot delete directory markers');
  }
  private validateTarget(input: unknown, jobId: string, rowId: string): StorageCleanupTarget {
    const target = cleanupTarget.parse(input);
    if (
      target.namespace !== this.namespace ||
      target.jobId !== jobId ||
      target.id !== cleanupHash(JSON.stringify([target.binding, target.key])) ||
      this.targetId(target) !== rowId
    )
      throw new Error('Storage cleanup target identity mismatch');
    return target;
  }
  async get(id: string): Promise<StorageCleanupJob> {
    return (await this.read(id)).job;
  }
  /** Missing is distinct from malformed state or a failed database read. */
  async find(id: string): Promise<StorageCleanupJob | null> {
    return (await this.readOptional(id))?.job ?? null;
  }
  /** A single bounded page. Public cursors contain only the last validated job UUID. */
  async listJobs(after: string | null = null) {
    const prefix = `sd-c:1:${this.namespaceHash}:`;
    const rows = await cleanupRows(
      this.database,
      this.dialect,
      prefix,
      after === null ? null : `${prefix}${z.uuid().parse(after)}`,
      100,
      'uuid',
    );
    const jobs = rows.map((row) => {
      const job = cleanupJob.parse(
        this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
      );
      if (job.namespace !== this.namespace || row.id !== this.jobId(job.id))
        throw new Error('Storage cleanup job identity mismatch');
      return job;
    });
    return { jobs, cursor: jobs.length === 100 ? jobs.at(-1)!.id : null };
  }
  async manifestStatus(id: string, pageId: string): Promise<{ resolved: boolean } | null> {
    return this.manifests().status((await this.read(id)).job, pageId);
  }
  /** Commit with authority removal and reference collection, before application cascades erase references. */
  async createJob(prepared: StorageCleanupJob): Promise<void> {
    const job = cleanupJob.parse(prepared);
    if (
      job.namespace !== this.namespace ||
      job.phase !== 'preparing' ||
      job.epoch !== 0 ||
      job.drainCursor !== null ||
      job.pending !== 0 ||
      job.deleted !== 0 ||
      job.verification !== 0 ||
      job.collectorCount !== 0 ||
      job.inventoryCount !== 0 ||
      job.remainingCollectors !== 0 ||
      job.manifestCount !== 0 ||
      job.unresolvedManifests !== 0
    )
      throw new Error('Storage cleanup must start with an empty prepared job');
    await this.writes().forbidWrites({
      schemaVersion: 1,
      kind: 'tombstone',
      namespace: job.namespace,
      subjectId: job.subjectId,
      generation: job.generation,
      jobId: job.id,
      createdAt: job.createdAt,
    });
    const backend = this.backend(this.jobId(job.id));
    const previous = await backend.read();
    if (previous) {
      if (JSON.stringify(cleanupJob.parse(previous.state)) !== JSON.stringify(job))
        throw new Error('Storage cleanup job already exists');
      return;
    }
    if (!(await backend.compareAndSwap(null, { revision: randomUUID(), state: job })))
      throw new Error('Storage cleanup changed concurrently');
  }
  /** Register bounded pages before freezing the scope set. No fixed limit on a job's scopes. */
  async registerCollectors(
    id: string,
    epoch: number,
    collectors: StorageCleanupCollector[],
  ): Promise<StorageCleanupJob> {
    const { job, revision } = await this.read(id, epoch);
    if (job.phase !== 'preparing') throw new Error('Storage cleanup collector scopes are frozen');
    if (collectors.length > 1000) throw new Error('Storage cleanup page exceeds its limit');
    for (const collector of collectors) {
      if (!(await this.collectors().register(job, collector))) continue;
      job.collectorCount++;
      job.remainingCollectors++;
      if (collector.kind === 'inventory') job.inventoryCount++;
    }
    await this.save(job, revision);
    return job;
  }
  async listCollectors(id: string, after: string | null = null) {
    const { job } = await this.read(id);
    return this.collectors().list(job, after);
  }
  /** Persist raw pre-cascade references. Unknown attribution remains unresolved and prevents cleanup. */
  async recordManifestPage(
    id: string,
    epoch: number,
    input: StorageManifestInput,
  ): Promise<StorageCleanupJob> {
    const { job, revision } = await this.read(id, epoch);
    if (job.phase !== 'preparing') throw new Error('Storage cleanup manifests are frozen');
    if (await this.manifests().register(job, input)) {
      job.manifestCount++;
      job.unresolvedManifests++;
      await this.save(job, revision);
    }
    return job;
  }
  async listManifests(id: string, after: string | null = null) {
    return this.manifests().list((await this.read(id)).job, after);
  }
  /**
   * The app proves ownership and classifies every raw entry. This transaction persists exact
   * targets under registered verification inventories together with immutable resolution provenance.
   * A non-storage classification must carry an explicit reason; unknown attribution is not one.
   */
  async resolveManifest(
    id: string,
    epoch: number,
    pageId: string,
    input: StorageManifestResolution,
  ): Promise<StorageCleanupJob> {
    const { job, revision } = await this.read(id, epoch);
    if (job.phase !== 'preparing') throw new Error('Storage cleanup manifests are frozen');
    const manifests = this.manifests();
    const { page } = await manifests.get(job, pageId);
    const resolution = manifests.validateResolution(page.entries.length, input);
    if (page.resolution) {
      await manifests.resolve(job, pageId, resolution);
      return job;
    }
    for (const entry of resolution.entries) {
      if (entry.kind !== 'storage') continue;
      for (const collectorId of entry.collectorIds ?? []) {
        const { collector } = await this.collectors().get(job, collectorId);
        if (collector.kind !== 'inventory')
          throw new Error('Storage manifest requires verification inventory collectors');
      }
      for (const target of entry.targets) await this.addTarget(job, target);
    }
    await manifests.resolve(job, pageId, resolution);
    job.unresolvedManifests--;
    await this.save(job, revision);
    return job;
  }
  /** Stop the previous iterator and all page processing first. A new iterator restarts from the beginning. */
  async restartCollector(id: string, epoch: number, collectorId: string): Promise<void> {
    const { job } = await this.read(id, epoch);
    const { collector, revision } = await this.collectors().get(job, collectorId);
    if (
      !['collecting', 'verifying'].includes(job.phase) ||
      collector.kind !== 'inventory' ||
      collector.complete
    )
      throw new Error('Storage cleanup collector cannot restart in this phase');
    collector.cursor = null;
    await this.collectors().save(collector, revision);
  }
  private async addTarget(job: StorageCleanupJob, input: StorageCleanupTargetInput): Promise<void> {
    const value = cleanupTargetInput.parse(input);
    await this.validateBackend(value);
    if (!(await this.collectors().covers(job, value)))
      throw new Error('Storage cleanup target has no verification inventory');
    const id = cleanupHash(JSON.stringify([value.binding, value.key]));
    const rowId = this.targetId({ jobId: job.id, id });
    const backend = this.backend(rowId);
    const previous = await backend.read();
    let target: StorageCleanupTarget;
    if (previous) {
      target = this.validateTarget(previous.state, job.id, rowId);
      if (!target.backendIds.includes(value.backendId)) target.backendIds.push(value.backendId);
      if (target.status === 'deleted') {
        if (job.phase !== 'verifying')
          throw new Error('Deleted storage target was rediscovered outside verification');
        target.status = 'pending';
        job.pending++;
        job.deleted--;
      }
    } else {
      target = {
        schemaVersion: 1,
        namespace: this.namespace,
        jobId: job.id,
        id,
        binding: value.binding,
        key: value.key,
        backendIds: [value.backendId],
        status: 'pending',
      };
      job.pending++;
    }
    if (
      !(await backend.compareAndSwap(previous?.revision ?? null, {
        revision: randomUUID(),
        state: cleanupTarget.parse(target),
      }))
    )
      throw new Error('Storage cleanup target changed concurrently');
  }
  /** No elapsed-time shortcut: active and uncertain writes keep the job waiting. */
  async recordDrainedIntents(id: string, epoch: number, after: string | null): Promise<StorageCleanupJob> {
    const { job, revision } = await this.read(id, epoch);
    if (job.phase !== 'waiting' || job.drainCursor !== after)
      throw new Error('Storage cleanup drain position changed');
    const tombstone = await this.writes().tombstone(job.subjectId);
    if (!tombstone || tombstone.jobId !== job.id || tombstone.generation !== job.generation)
      throw new Error('Storage cleanup requires its permanent write tombstone');
    const page = await this.writes().list(job.subjectId, { after: after ?? undefined, limit: 100 });
    if (page.intents.some((intent) => intent.status !== 'settled'))
      throw new Error('Storage cleanup is waiting for write completion');
    for (const intent of page.intents) await this.addTarget(job, intent.target);
    // Settled intents remain durable. No crash can lose their targets between these writes.
    job.drainCursor = page.cursor;
    if (page.cursor === null) {
      job.phase = 'collecting';
      job.epoch++;
    }
    await this.save(job, revision);
    return job;
  }
  /** Inventory starts after drain. Reference snapshots may be saved with the initial deletion transaction. */
  async recordCollectorPage(input: {
    jobId: string;
    epoch: number;
    collectorId: string;
    after: string | null;
    next: string | null;
    targets: StorageCleanupTargetInput[];
  }): Promise<StorageCleanupJob> {
    const { job, revision } = await this.read(input.jobId, input.epoch);
    const { collector, revision: collectorRevision } = await this.collectors().get(job, input.collectorId);
    if (!collector || collector.complete || collector.cursor !== input.after)
      throw new Error('Storage cleanup collector position changed');
    if (
      !['collecting', 'verifying'].includes(job.phase) &&
      !(['preparing', 'waiting'].includes(job.phase) && collector.kind === 'references')
    )
      throw new Error('Storage cleanup collector cannot run in this phase');
    if (job.phase === 'verifying' && collector.kind !== 'inventory')
      throw new Error('Storage cleanup verification requires backend inventory');
    if (input.next !== null && (!input.next || input.next === input.after || input.next.length > 8192))
      throw new Error('Storage cleanup collector did not advance');
    if (input.targets.length > 1000) throw new Error('Storage cleanup page exceeds its limit');
    for (const target of input.targets) {
      if (!collector.backendIds.includes(target.backendId))
        throw new Error('Storage cleanup target is outside its collector backend scope');
      if (
        collector.kind === 'inventory' &&
        (collector.match === 'key' ? target.key !== collector.scope : !target.key.startsWith(collector.scope))
      )
        throw new Error('Storage cleanup target is outside its inventory prefix');
      await this.addTarget(job, target);
    }
    collector.cursor = input.next;
    collector.complete = input.next === null;
    if (collector.complete) job.remainingCollectors--;
    await this.collectors().save(collector, collectorRevision);
    await this.save(job, revision);
    return job;
  }
  /** Each phase change invalidates deletion tickets from previous passes. */
  async transition(id: string, epoch: number): Promise<StorageCleanupJob> {
    const { job, revision } = await this.read(id, epoch);
    if (job.phase === 'preparing') {
      if (job.unresolvedManifests !== 0)
        throw new Error('Storage cleanup has unresolved reference manifests');
      if (job.inventoryCount === 0) throw new Error('Storage cleanup requires a verification inventory');
      job.phase = 'waiting';
    } else if (job.phase === 'collecting') {
      if (job.remainingCollectors !== 0) throw new Error('Storage cleanup discovery is incomplete');
      job.phase = 'ready';
    } else if (job.phase === 'ready') {
      job.phase = 'deleting';
    } else if (job.phase === 'verifying') {
      if (job.remainingCollectors !== 0) throw new Error('Storage cleanup verification is incomplete');
      if (job.pending === 0 && job.retentionPolicy) {
        await new JobRetentionCleanup(this.database, this.dialect, this.namespace).step(job.id);
        const proof = await retentionBackend(this.database, this.dialect, this.namespace, job.id).read();
        const state = proof ? retentionStateSchema.parse(proof.state) : null;
        if (!state || state.binding !== retentionBinding(job) || state.policy !== job.retentionPolicy)
          throw new Error('Storage cleanup retention proof is invalid');
        if (state.phase !== 'complete') {
          job.epoch++;
          await this.save(job, revision);
          return job;
        }
        if (state.cursor !== null || state.activeId !== null)
          throw new Error('Storage cleanup retention cursor is incomplete');
      }
      job.phase = job.pending === 0 ? 'complete' : 'deleting';
    } else throw new Error('Storage cleanup cannot advance in this phase');
    job.epoch++;
    await this.save(job, revision);
    return job;
  }
  async beginVerification(id: string, epoch: number): Promise<StorageCleanupJob> {
    const { job, revision } = await this.read(id, epoch);
    if (job.phase !== 'deleting' || job.pending !== 0)
      throw new Error('Storage cleanup still has pending targets');
    if (job.inventoryCount === 0) throw new Error('Storage cleanup requires a verification inventory');
    job.phase = 'verifying';
    job.epoch++;
    job.verification++;
    job.remainingCollectors = job.inventoryCount;
    await this.save(job, revision);
    return job;
  }
  /** Cursor advances across all rows, including acknowledged targets, to bound each database read. */
  async pendingTargets(
    id: string,
    epoch: number,
    after: string | null = null,
  ): Promise<{
    tickets: StorageDeletionTicket[];
    cursor: string | null;
  }> {
    const { job } = await this.read(id, epoch);
    if (job.phase !== 'deleting') throw new Error('Storage cleanup is not deleting');
    const prefix = this.targetPrefix(id);
    const rows = await cleanupRows(this.database, this.dialect, prefix, after);
    const tickets: StorageDeletionTicket[] = [];
    for (const row of rows) {
      const target = this.validateTarget(
        this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
        id,
        String(row.id),
      );
      if (typeof row.revision !== 'string') throw new Error('Invalid storage cleanup target revision');
      if (target.status === 'pending') tickets.push({ jobId: id, epoch, target, revision: row.revision });
    }
    return { tickets, cursor: rows.length === 100 ? String(rows.at(-1)!.id) : null };
  }
  /** Call only after observed successful deletion, while retaining backend ownership. */
  async acknowledgeTarget(ticket: StorageDeletionTicket): Promise<void> {
    const { job, revision } = await this.read(ticket.jobId, ticket.epoch);
    if (job.phase !== 'deleting') throw new Error('Storage cleanup is not deleting');
    const rowId = this.targetId(ticket.target);
    const backend = this.backend(rowId);
    const previous = await backend.read();
    if (!previous || previous.revision !== ticket.revision)
      throw new Error('Storage cleanup deletion ticket is stale');
    const target = this.validateTarget(previous.state, job.id, rowId);
    if (
      JSON.stringify(target) !== JSON.stringify(cleanupTarget.parse(ticket.target)) ||
      target.status !== 'pending'
    )
      throw new Error('Storage cleanup deletion ticket does not match');
    if (
      !(await backend.compareAndSwap(previous.revision, {
        revision: randomUUID(),
        state: { ...target, status: 'deleted' },
      }))
    )
      throw new Error('Storage cleanup target changed concurrently');
    job.pending--;
    job.deleted++;
    await this.save(job, revision);
  }
}
