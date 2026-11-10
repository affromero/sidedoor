import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateStorageKey } from '../registry/references';
import { sqlStateBackend, sqlStateRows, type SqlExecutor } from '../sql/sql';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z.discriminatedUnion('status', [
  z.object({ kind: z.literal('storage_target_fence'), target: digest, status: z.literal('open') }).strict(),
  z
    .object({
      kind: z.literal('storage_target_fence'),
      target: digest,
      status: z.literal('retired'),
      retirement: digest,
    })
    .strict(),
]);

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * All methods require the caller's Serializable transaction. The key is global to
 * this database so namespaces sharing a physical backend cannot bypass the fence.
 */
export class StorageTargetFence {
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
  ) {}

  private target(input: { binding: string; key: string }, allowDirectoryMarker = false) {
    const marker = allowDirectoryMarker && input.key.endsWith('/');
    const key = marker ? `${validateStorageKey(input.key.slice(0, -1))}/` : validateStorageKey(input.key);
    return hash(JSON.stringify([digest.parse(input.binding), key]));
  }

  private decode(value: unknown) {
    return this.dialect === 'sqlite' && typeof value === 'string' ? JSON.parse(value) : value;
  }

  private async requireDrained(
    target: string,
    cleanup?: { namespace: string; subjectId: string; generation: number },
  ) {
    const { storageWriteIntentSchema } = await import('./write-journal');
    const { storageAssetSchema } = await import('../registry/reference-registry');
    let after: string | null = null;
    do {
      const rows = await sqlStateRows(this.database, this.dialect, 'sd-w:1:', after, 100, 'writeIntent');
      for (const row of rows) {
        const intent = storageWriteIntentSchema.parse(this.decode(row.state));
        const expected = `sd-w:1:${hash(intent.namespace)}:${hash(intent.subjectId)}:${intent.operationId}`;
        if (row.id !== expected) throw new Error('Storage write identity mismatch');
        if (this.target(intent.target) !== target) continue;
        const settledUnreferenced =
          intent.status === 'settled' &&
          intent.outcome === 'unreferenced' &&
          intent.resolution?.kind !== 'stopped_writer';
        const settledOwned =
          cleanup !== undefined &&
          intent.status === 'settled' &&
          intent.resolution?.kind !== 'stopped_writer' &&
          intent.namespace === cleanup.namespace &&
          intent.subjectId === cleanup.subjectId &&
          intent.generation === cleanup.generation;
        if (!cleanup || (!settledUnreferenced && !settledOwned))
          throw new Error('Storage target has retained writes');
      }
      after = rows.length === 100 ? String(rows.at(-1)!.id) : null;
    } while (after);
    after = null;
    do {
      const rows = await sqlStateRows(
        this.database,
        this.dialect,
        'sd-asset:1:',
        after,
        100,
        'compoundDigest',
      );
      for (const row of rows) {
        const asset = storageAssetSchema.parse(this.decode(row.state));
        if (
          row.id !== `sd-asset:1:${hash(asset.prepared.namespace)}:${asset.id}` ||
          asset.id !== this.target(asset.prepared.target)
        )
          throw new Error('Storage asset identity mismatch');
        if (asset.id === target && asset.consumers.length)
          throw new Error('Storage target has live consumers');
      }
      after = rows.length === 100 ? String(rows.at(-1)!.id) : null;
    } while (after);
  }

  /** Serialize a new writer or reference allocation against target retirement. */
  async admit(input: { binding: string; key: string }): Promise<void> {
    const target = this.target(input);
    const backend = sqlStateBackend(this.database, this.dialect, `sd-tf:1:${target}`);
    const row = await backend.read();
    if (row) {
      const state = stateSchema.parse(row.state);
      if (state.target !== target) throw new Error('Storage target fence identity mismatch');
      if (state.status === 'retired') throw new Error('Storage target is retired');
    }
    if (
      !(await backend.compareAndSwap(row?.revision ?? null, {
        revision: randomUUID(),
        state: { kind: 'storage_target_fence', target, status: 'open' },
      }))
    )
      throw new Error('Storage target fence changed concurrently');
  }

  async requireRetired(input: { binding: string; key: string; retirementId: string }): Promise<void> {
    const target = this.target(input);
    const retirement = hash(z.uuid().parse(input.retirementId));
    const row = await sqlStateBackend(this.database, this.dialect, `sd-tf:1:${target}`).read();
    if (!row) throw new Error('Storage target retirement is missing');
    const state = stateSchema.parse(row.state);
    if (state.target !== target || state.status !== 'retired' || state.retirement !== retirement)
      throw new Error('Storage target retirement mismatch');
  }

  /** Fence an exact cleanup ticket before dispatch; all callers share one Serializable transaction. */
  async retireForCleanup(input: {
    binding: string;
    key: string;
    namespace: string;
    jobId: string;
    epoch: number;
    executionId: string;
  }): Promise<void> {
    const { StorageCleanupJournal } = await import('../cleanup/cleanup-journal');
    const { StorageWriteJournal } = await import('./write-journal');
    const job = await new StorageCleanupJournal(this.database, this.dialect, input.namespace).get(
      input.jobId,
    );
    const tombstone = await new StorageWriteJournal(this.database, this.dialect, input.namespace).tombstone(
      job.subjectId,
    );
    if (
      job.phase !== 'deleting' ||
      job.epoch !== input.epoch ||
      tombstone?.jobId !== job.id ||
      tombstone.generation !== job.generation
    )
      throw new Error('Storage target cleanup authority does not match');
    const target = this.target(input, true);
    const retirement = hash(job.id);
    const backend = sqlStateBackend(this.database, this.dialect, `sd-tf:1:${target}`);
    const row = await backend.read();
    let alreadyRetired = false;
    if (row) {
      const state = stateSchema.parse(row.state);
      if (state.target !== target) throw new Error('Storage target fence identity mismatch');
      if (state.status === 'retired') {
        if (state.retirement !== retirement) {
          const { StorageCleanupAttribution } = await import('../cleanup/cleanup-attribution');
          const delegated = await new StorageCleanupAttribution(
            this.database,
            this.dialect,
            input.namespace,
          ).authorizeDelegatedRetirement({
            jobId: input.jobId,
            epoch: input.epoch,
            binding: input.binding,
            key: input.key,
            retirement: state.retirement,
          });
          if (!delegated) {
            const { CleanupExecutionJournal } = await import('../cleanup/cleanup-execution');
            const executions = new CleanupExecutionJournal(this.database, this.dialect, input.namespace);
            const current = await executions.current(input.binding);
            if (
              !current ||
              current.status !== 'active' ||
              current.jobId !== job.id ||
              current.executionId !== z.uuid().parse(input.executionId)
            )
              throw new Error('Storage cleanup execution no longer owns this backend');
            let cursor: string | null = null;
            let confirmed = false;
            do {
              const page = await new StorageCleanupJournal(
                this.database,
                this.dialect,
                input.namespace,
              ).listJobs(cursor);
              for (const previous of page.jobs) {
                if (previous.id === job.id || previous.phase !== 'complete') continue;
                if (
                  !(await new StorageCleanupJournal(
                    this.database,
                    this.dialect,
                    input.namespace,
                  ).hasCompletedTarget(previous.id, input))
                )
                  continue;
                const previousTombstone = await new StorageWriteJournal(
                  this.database,
                  this.dialect,
                  input.namespace,
                ).tombstone(previous.subjectId);
                if (
                  previousTombstone?.jobId !== previous.id ||
                  previousTombstone.generation !== previous.generation
                )
                  continue;
                const matchingRetirement =
                  hash(previous.id) === state.retirement ||
                  (await new StorageCleanupAttribution(
                    this.database,
                    this.dialect,
                    input.namespace,
                  ).hasCompletedDelegatedRetirement({
                    jobId: previous.id,
                    epoch: previous.epoch,
                    binding: input.binding,
                    key: input.key,
                    retirement: state.retirement,
                  }));
                if (!matchingRetirement) continue;
                confirmed = await executions.hasSettled(
                  previous.id,
                  input.binding,
                  current.executionId,
                  job.id,
                );
                break;
              }
              if (confirmed || page.cursor === null) break;
              if (cursor && page.cursor <= cursor)
                throw new Error('Storage cleanup history cursor did not advance');
              cursor = page.cursor;
            } while (cursor !== null);
            if (!confirmed) throw new Error('Storage target has another retirement');
          }
        }
        alreadyRetired = true;
      }
    }
    await this.requireDrained(target, job);
    if (alreadyRetired) return;
    if (
      !(await backend.compareAndSwap(row?.revision ?? null, {
        revision: randomUUID(),
        state: { kind: 'storage_target_fence', target, status: 'retired', retirement },
      }))
    )
      throw new Error('Storage target fence changed concurrently');
  }

  /** Caller must fence queued work and use a Serializable transaction before deletion. */
  async retire(input: { binding: string; key: string; retirementId: string }): Promise<void> {
    const target = this.target(input);
    const retirement = hash(z.uuid().parse(input.retirementId));
    const backend = sqlStateBackend(this.database, this.dialect, `sd-tf:1:${target}`);
    const row = await backend.read();
    if (row) {
      const state = stateSchema.parse(row.state);
      if (state.target !== target) throw new Error('Storage target fence identity mismatch');
      if (state.status === 'retired') {
        if (state.retirement !== retirement) throw new Error('Storage target was already retired');
        return;
      }
    }
    await this.requireDrained(target);
    if (
      !(await backend.compareAndSwap(row?.revision ?? null, {
        revision: randomUUID(),
        state: { kind: 'storage_target_fence', target, status: 'retired', retirement },
      }))
    )
      throw new Error('Storage target fence changed concurrently');
  }
}
