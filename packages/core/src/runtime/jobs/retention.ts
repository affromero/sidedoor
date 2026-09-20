import { randomUUID } from 'node:crypto';
import { JobOutbox } from './outbox';
import { JobSnapshot } from './snapshot';
import { JobExecutionJournal } from './execution-journal';
import { retentionBackend, retentionBinding, retentionPolicy, retentionStateSchema } from './retention-state';
import { StorageCleanupJournal } from '../../storage/cleanup/cleanup-journal';
import { StorageWriteJournal } from '../../storage/execution/write-journal';
import type { SqlExecutor } from '../../storage/sql/sql';

/**
 * Caller-owned Serializable steps. Applications opting into this policy must use job-ID
 * snapshots and fence final mutations of non-storage workers against deletion admission.
 */
export class JobRetentionCleanup {
  constructor(
    private readonly database: SqlExecutor,
    private readonly dialect: 'postgres' | 'sqlite',
    private readonly namespace: string,
  ) {}
  private async admission(id: string) {
    const job = await new StorageCleanupJournal(this.database, this.dialect, this.namespace).get(id);
    if (job.retentionPolicy !== retentionPolicy)
      throw new Error('Cleanup retention policy is not registered');
    const tombstone = await new StorageWriteJournal(this.database, this.dialect, this.namespace).tombstone(
      job.subjectId,
    );
    if (!tombstone || tombstone.jobId !== job.id || tombstone.generation !== job.generation)
      throw new Error('Cleanup retention requires matching deletion admission');
    return job;
  }
  async step(id: string): Promise<{ complete: boolean }> {
    const job = await this.admission(id);
    if (!['collecting', 'ready', 'deleting', 'verifying', 'complete'].includes(job.phase))
      throw new Error('Cleanup retention must run after writer drain and before completion');
    const backend = retentionBackend(this.database, this.dialect, this.namespace, id);
    const row = await backend.read();
    const state = row
      ? retentionStateSchema.parse(row.state)
      : {
          kind: 'job_retention' as const,
          policy: retentionPolicy,
          binding: retentionBinding(job),
          phase: 'backfill' as const,
          cursor: null,
          activeId: null,
        };
    if (state.binding !== retentionBinding(job)) throw new Error('Cleanup retention identity mismatch');
    if (state.phase === 'complete') return { complete: true };
    if (job.phase === 'complete') throw new Error('Completed cleanup has no terminal retention proof');
    const next = { ...state };
    const outbox = new JobOutbox(this.database, this.dialect, this.namespace);
    if (state.phase === 'backfill') {
      const page = await outbox.backfillScopeIndex(state.cursor);
      next.cursor = page.cursor;
      if (page.cursor === null) next.phase = 'jobs';
    } else {
      const page = await outbox.listForScope(job.subjectId, job.generation, state.cursor);
      if (state.activeId !== null && page.jobs[0]?.id !== state.activeId)
        throw new Error('Cleanup retention active job changed');
      for (const entry of page.jobs) {
        const receipt = await outbox.receipt(entry.id);
        if (!receipt || receipt.fingerprint !== entry.fingerprint)
          throw new Error('Cleanup retention job identity mismatch');
        await new JobExecutionJournal(this.database, this.dialect, this.namespace).requireParentDrained(
          entry.id,
          entry.fingerprint,
        );
        if (
          !(
            await new JobSnapshot(this.database, this.dialect, this.namespace).eraseNext(
              entry.id,
              entry.fingerprint,
            )
          ).complete
        ) {
          next.activeId = entry.id;
          break;
        }
        if (receipt.status !== 'erased') {
          if (receipt.status === 'pending') await outbox.complete(entry.id, entry.fingerprint);
          await outbox.erase(entry.id, entry.fingerprint, {
            subjectId: job.subjectId,
            generation: job.generation,
          });
        }
        next.cursor = entry.id;
        next.activeId = null;
      }
      if (next.activeId === null && page.cursor === null) {
        next.phase = 'complete';
        next.cursor = null;
      }
    }
    if (!(await backend.compareAndSwap(row?.revision ?? null, { revision: randomUUID(), state: next })))
      throw new Error('Concurrent retention cleanup; retry the complete transaction');
    return { complete: next.phase === 'complete' };
  }
}
