import { createHash, randomUUID } from 'node:crypto';
export { JobSnapshot } from './snapshot';
export {
  JobExecutionAdmissionConflict,
  JobExecutionJournal,
  type JobExecutionBinding,
  type JobExecutionRecord,
} from './execution-journal';
export { runJobExecution, JobExecutionCleanupError, isJobExecutionCleanupFailure } from './job-execution';
export { JobRetentionCleanup } from './retention';
export {
  reconcileOutboxPage,
  type JobDeliveryReference,
  type JobDeliveryOutcome,
  type JobDeliveryResult,
} from './reconciliation';
import { z } from 'zod';
import { canonicalJson as canonical } from '../process/json';
import { sqlStateBackend, sqlStateRows, type SqlExecutor } from '../../storage/sql/sql';
import { StorageWriteJournal } from '../../storage/execution/write-journal';
import { StorageCleanupJournal } from '../../storage/cleanup/cleanup-journal';
import { JobExecutionJournal } from './execution-journal';

const identity = z.string().min(1).max(200);
const scope = z.object({ subjectId: identity, generation: z.number().int().nonnegative().safe() }).strict();
const jobSchema = z
  .object({
    id: z.uuid(),
    namespace: identity,
    handler: identity,
    version: z.number().int().positive().safe(),
    payload: z.json(),
    scopes: z.array(scope).min(1).max(100),
    delivery: z
      .object({
        attempts: z.number().int().min(1).max(100),
        priority: z.number().int().min(0).max(2_097_152),
        availableAt: z.number().int().nonnegative().safe(),
      })
      .strict(),
  })
  .strict();
const recordSchema = z
  .object({
    kind: z.literal('outbox_job'),
    job: jobSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    delivered: z.boolean(),
    complete: z.boolean(),
  })
  .strict();
const pendingSchema = z
  .object({
    kind: z.literal('outbox_pending'),
    namespace: identity,
    id: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type PreparedJob = z.infer<typeof jobSchema>;
export type OutboxJob = z.infer<typeof recordSchema>;
const erasedSchema = z
  .object({
    kind: z.literal('outbox_erased'),
    namespace: identity,
    id: z.uuid(),
    handler: identity,
    version: z.number().int().positive().safe(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    scopeDigests: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(100),
  })
  .strict();
export type ErasedJobReceipt = z.infer<typeof erasedSchema>;
export class JobErasedError extends Error {
  constructor(readonly receipt: ErasedJobReceipt) {
    super('Job payload was erased');
    this.name = 'JobErasedError';
  }
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/** Prepare outside transaction retries. Payloads must contain references, never provider credentials. */
export function prepareJob(input: Omit<PreparedJob, 'id'> & { id?: string }): PreparedJob {
  const job = jobSchema.parse({ ...input, id: input.id ?? randomUUID() });
  if (new Set(job.scopes.map((item) => item.subjectId)).size !== job.scopes.length)
    throw new Error('Job scopes must have distinct subjects');
  if (Buffer.byteLength(canonical(job)) > 1_048_576) throw new Error('Job exceeds the one MiB limit');
  return structuredClone(job);
}

/**
 * Bind every mutation to the caller's Serializable transaction alongside application changes.
 * Delivery is at least once. Workers revalidate captured scopes, then call complete before
 * applying their final database mutations in that same transaction. A false result skips
 * those mutations. External effects need their own durable protocol, such as storage intents.
 */
export class JobOutbox {
  private readonly prefix: string;
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {
    this.prefix = hash(identity.parse(namespace));
  }
  private key(id: string, index: 'pending' | 'incomplete' | null = null) {
    return `sd-${index === 'pending' ? 'jp' : index === 'incomplete' ? 'ji' : 'j'}:1:${this.prefix}:${z.uuid().parse(id)}`;
  }
  private backend(id: string) {
    return sqlStateBackend(this.database, this.dialect, this.key(id));
  }
  private scopePrefix(subjectId: string, generation: number) {
    const validated = scope.parse({ subjectId, generation });
    return `sd-jsc:1:${this.prefix}:${hash(canonical(validated))}:`;
  }
  private validate(job: PreparedJob) {
    const prepared = prepareJob(job);
    if (prepared.namespace !== this.namespace) throw new Error('Job namespace mismatch');
    return prepared;
  }
  private parse(value: unknown, id: string) {
    const erased = erasedSchema.safeParse(value);
    if (erased.success) {
      if (erased.data.namespace !== this.namespace || erased.data.id !== id)
        throw new Error('Erased job identity mismatch');
      throw new JobErasedError(erased.data);
    }
    const record = recordSchema.parse(value);
    this.validate(record.job);
    if (record.job.id !== id || hash(canonical(record.job)) !== record.fingerprint)
      throw new Error('Job identity mismatch');
    return record;
  }
  async read(id: string): Promise<OutboxJob | null> {
    const row = await this.backend(id).read();
    return row ? this.parse(row.state, id) : null;
  }
  /** Parent cancellation is terminal, but never evidence that its application work succeeded. */
  async readParent(
    id: string,
    expected: {
      fingerprint: string;
      handler: string;
      version: number;
      scopes: readonly { subjectId: string; generation: number }[];
    },
  ) {
    const contract = z
      .object({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        handler: identity,
        version: z.number().int().positive().safe(),
        scopes: z.array(scope).min(1).max(100),
      })
      .strict()
      .parse(expected);
    if (new Set(contract.scopes.map((item) => item.subjectId)).size !== contract.scopes.length)
      throw new Error('Parent scopes must have distinct subjects');
    let record: OutboxJob | null;
    try {
      record = await this.read(id);
    } catch (error) {
      if (!(error instanceof JobErasedError)) throw error;
      const receipt = error.receipt;
      if (
        receipt.fingerprint !== contract.fingerprint ||
        receipt.handler !== contract.handler ||
        receipt.version !== contract.version ||
        canonical([...receipt.scopeDigests].sort()) !==
          canonical(contract.scopes.map((item) => hash(canonical(item))).sort())
      )
        throw new Error('Erased parent does not match expected work', { cause: error });
      return { status: 'erased' as const };
    }
    if (
      !record ||
      record.fingerprint !== contract.fingerprint ||
      record.job.handler !== contract.handler ||
      record.job.version !== contract.version ||
      canonical([...record.job.scopes].sort((a, b) => a.subjectId.localeCompare(b.subjectId))) !==
        canonical([...contract.scopes].sort((a, b) => a.subjectId.localeCompare(b.subjectId)))
    )
      throw new Error('Parent does not match expected work');
    return { status: record.complete ? ('complete' as const) : ('pending' as const), record };
  }
  /** A terminal erased receipt is distinct from successful application completion. */
  async receipt(id: string) {
    try {
      const record = await this.read(id);
      if (!record) return null;
      return {
        status: record.complete ? ('complete' as const) : ('pending' as const),
        id: record.job.id,
        handler: record.job.handler,
        version: record.job.version,
        fingerprint: record.fingerprint,
      };
    } catch (error) {
      if (!(error instanceof JobErasedError)) throw error;
      return {
        status: 'erased' as const,
        id: error.receipt.id,
        handler: error.receipt.handler,
        version: error.receipt.version,
        fingerprint: error.receipt.fingerprint,
      };
    }
  }

  /** Caller must drain writers and cancel dependent work before erasing retained payloads. */
  async erase(
    id: string,
    fingerprint: string,
    captured: { subjectId: string; generation: number },
  ): Promise<void> {
    scope.parse(captured);
    await new JobExecutionJournal(this.database, this.dialect, this.namespace).requireParentDrained(
      id,
      fingerprint,
    );
    const tombstone = await new StorageWriteJournal(this.database, this.dialect, this.namespace).tombstone(
      captured.subjectId,
    );
    if (!tombstone || tombstone.generation !== captured.generation)
      throw new Error('Job payload erasure requires matching deletion admission');
    const deletion = await new StorageCleanupJournal(this.database, this.dialect, this.namespace).get(
      tombstone.jobId,
    );
    if (
      deletion.subjectId !== captured.subjectId ||
      deletion.generation !== captured.generation ||
      deletion.namespace !== this.namespace
    )
      throw new Error('Job payload erasure cleanup identity mismatch');
    const backend = this.backend(id);
    const row = await backend.read();
    if (!row) throw new Error('Job does not exist');
    let record: OutboxJob;
    try {
      record = this.parse(row.state, id);
    } catch (error) {
      if (!(error instanceof JobErasedError)) throw error;
      if (
        error.receipt.fingerprint !== fingerprint ||
        !error.receipt.scopeDigests.includes(hash(canonical(captured)))
      )
        throw new Error('Erased job acknowledgement identity mismatch', { cause: error });
      return;
    }
    if (
      !record.complete ||
      record.fingerprint !== fingerprint ||
      !record.job.scopes.some(
        (item) => item.subjectId === captured.subjectId && item.generation === captured.generation,
      )
    )
      throw new Error('Job payload erasure requires matching completed work');
    const erased: ErasedJobReceipt = {
      kind: 'outbox_erased',
      namespace: this.namespace,
      id,
      fingerprint,
      handler: record.job.handler,
      version: record.job.version,
      scopeDigests: record.job.scopes.map((item) => hash(canonical(item))),
    };
    if (!(await backend.compareAndSwap(row.revision, { revision: randomUUID(), state: erased })))
      throw new Error('Concurrent job erasure; retry the complete transaction');
    const p = this.dialect === 'postgres' ? '$1' : '?';
    for (const index of ['pending', 'incomplete'] as const)
      await this.database.query(`DELETE FROM "SidedoorState" WHERE "id" = ${p} RETURNING "id"`, [
        this.key(id, index),
      ]);
  }
  async enqueue(input: PreparedJob): Promise<OutboxJob> {
    const job = this.validate(input);
    const fingerprint = hash(canonical(job));
    const backend = this.backend(job.id);
    const existing = await backend.read();
    if (existing) {
      let record: OutboxJob;
      try {
        record = this.parse(existing.state, job.id);
      } catch (error) {
        if (!(error instanceof JobErasedError)) throw error;
        if (error.receipt.fingerprint !== fingerprint)
          throw new Error('Job operation was already used for different work', { cause: error });
        throw error;
      }
      if (record.fingerprint !== fingerprint)
        throw new Error('Job operation was already used for different work');
      return record;
    }
    const writes = new StorageWriteJournal(this.database, this.dialect, this.namespace);
    for (const captured of job.scopes)
      if (await writes.tombstone(captured.subjectId)) throw new Error('Job scope is being erased');
    const record: OutboxJob = { kind: 'outbox_job', job, fingerprint, delivered: false, complete: false };
    if (!(await backend.compareAndSwap(null, { revision: randomUUID(), state: record })))
      throw new Error('Concurrent job enqueue; retry the complete transaction');
    const pending = { kind: 'outbox_pending', namespace: this.namespace, id: job.id, fingerprint };
    for (const index of ['pending', 'incomplete'] as const) {
      if (
        !(await sqlStateBackend(this.database, this.dialect, this.key(job.id, index)).compareAndSwap(null, {
          revision: randomUUID(),
          state: pending,
        }))
      )
        throw new Error('Job index already exists');
    }
    await this.indexScopes(record);
    return structuredClone(record);
  }

  private async indexScopes(record: OutboxJob) {
    const { job, fingerprint } = record;
    const pending = { kind: 'outbox_pending', namespace: this.namespace, id: job.id, fingerprint };
    for (const captured of job.scopes) {
      const key = `${this.scopePrefix(captured.subjectId, captured.generation)}${job.id}`;
      const backend = sqlStateBackend(this.database, this.dialect, key);
      const existing = await backend.read();
      if (existing) {
        const entry = pendingSchema.parse(existing.state);
        if (canonical(entry) !== canonical(pending))
          throw new Error('Job scope index conflicts with captured work');
        continue;
      }
      if (
        !(await backend.compareAndSwap(null, {
          revision: randomUUID(),
          state: pending,
        }))
      )
        throw new Error('Concurrent scope indexing; retry the complete transaction');
    }
  }

  /** Backfill old retained work. Persist the returned cursor in this same transaction. */
  async backfillScopeIndex(after: string | null = null) {
    const prefix = `sd-j:1:${this.prefix}:`;
    // Each retained payload can be one MiB, so scan fewer rows than identity-only indexes.
    const rows = await sqlStateRows(
      this.database,
      this.dialect,
      prefix,
      after === null ? null : `${prefix}${z.uuid().parse(after)}`,
      10,
      'uuid',
    );
    let last: string | null = null;
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id.startsWith(prefix))
        throw new Error('Job backfill namespace mismatch');
      const id = z.uuid().parse(row.id.slice(prefix.length));
      try {
        const record = this.parse(
          this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
          id,
        );
        await this.indexScopes(record);
      } catch (error) {
        if (!(error instanceof JobErasedError)) throw error;
      }
      last = id;
    }
    return { indexed: rows.length, cursor: rows.length === 10 ? last : null };
  }

  /** Ten validated jobs per page, including completed work and retained erased receipts. */
  async listForScope(subjectId: string, generation: number, after: string | null = null) {
    const prefix = this.scopePrefix(subjectId, generation);
    const rows = await sqlStateRows(
      this.database,
      this.dialect,
      prefix,
      after === null ? null : `${prefix}${z.uuid().parse(after)}`,
      10,
      'uuid',
    );
    const jobs: Array<{ id: string; fingerprint: string }> = [];
    for (const row of rows) {
      const entry = pendingSchema.parse(
        this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
      );
      if (entry.namespace !== this.namespace || row.id !== `${prefix}${entry.id}`)
        throw new Error('Job scope index identity mismatch');
      try {
        const record = await this.read(entry.id);
        if (
          !record ||
          record.fingerprint !== entry.fingerprint ||
          !record.job.scopes.some(
            (captured) => captured.subjectId === subjectId && captured.generation === generation,
          )
        )
          throw new Error('Job scope index does not match captured work');
      } catch (error) {
        if (!(error instanceof JobErasedError)) throw error;
        if (
          error.receipt.fingerprint !== entry.fingerprint ||
          !error.receipt.scopeDigests.includes(hash(canonical({ subjectId, generation })))
        )
          throw new Error('Job scope index does not match erased work', { cause: error });
      }
      jobs.push({ id: entry.id, fingerprint: entry.fingerprint });
    }
    return { jobs, cursor: jobs.length === 10 ? jobs.at(-1)!.id : null };
  }
  private async list(
    index: 'pending' | 'incomplete',
    after: string | null,
  ): Promise<{ jobs: Array<{ id: string; fingerprint: string }>; cursor: string | null }> {
    const prefix = `sd-${index === 'pending' ? 'jp' : 'ji'}:1:${this.prefix}:`;
    const rows = await sqlStateRows(
      this.database,
      this.dialect,
      prefix,
      after === null ? null : `${prefix}${z.uuid().parse(after)}`,
      100,
      'uuid',
    );
    const jobs = rows.map((row) => {
      const pending = pendingSchema.parse(
        this.dialect === 'sqlite' && typeof row.state === 'string' ? JSON.parse(row.state) : row.state,
      );
      if (pending.namespace !== this.namespace || this.key(pending.id, index) !== row.id)
        throw new Error('Job pending index identity mismatch');
      return { id: pending.id, fingerprint: pending.fingerprint };
    });
    return { jobs, cursor: jobs.length === 100 ? jobs.at(-1)!.id : null };
  }
  /** Only identifiers are paged, so large payloads never multiply the page memory bound. */
  listPending(after: string | null = null) {
    return this.list('pending', after);
  }
  /** Reconcile these operations with the queue even after acceptance, including after Redis data loss. */
  listIncomplete(after: string | null = null) {
    return this.list('incomplete', after);
  }
  private async update(id: string, fingerprint: string, field: 'delivered' | 'complete') {
    const backend = this.backend(id);
    const row = await backend.read();
    if (!row) throw new Error('Job does not exist');
    const record = this.parse(row.state, id);
    if (record.fingerprint !== fingerprint) throw new Error('Job acknowledgement identity mismatch');
    if (record[field]) return false;
    record[field] = true;
    if (!(await backend.compareAndSwap(row.revision, { revision: randomUUID(), state: record })))
      throw new Error('Concurrent job update; retry the complete transaction');
    const p = this.dialect === 'postgres' ? '$1' : '?';
    await this.database.query(`DELETE FROM "SidedoorState" WHERE "id" = ${p} RETURNING "id"`, [
      this.key(id, 'pending'),
    ]);
    if (field === 'complete')
      await this.database.query(`DELETE FROM "SidedoorState" WHERE "id" = ${p} RETURNING "id"`, [
        this.key(id, 'incomplete'),
      ]);
    return true;
  }
  /** Call only after observing acceptance of this exact immutable operation by the queue. */
  acknowledgeDelivery(id: string, fingerprint: string) {
    return this.update(id, fingerprint, 'delivered');
  }
  /** Permanent receipt prevents duplicate final application commits after queue retention expires. */
  complete(id: string, fingerprint: string) {
    return this.update(id, fingerprint, 'complete');
  }
}
