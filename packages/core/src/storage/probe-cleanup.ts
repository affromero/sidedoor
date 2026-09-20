import { StorageCleanupJournal } from './cleanup-journal';
import { StorageBackendRegistry } from './backend-registry';
import type { StorageCleanupTargetInput } from './cleanup-state';
import type { SqlExecutor } from './sql';
import { CleanupExecutionJournal, type CleanupExecutionBinding } from './cleanup-execution';

export interface ProbeCleanupOptions<Transaction> {
  namespace: string;
  dialect: 'postgres' | 'sqlite';
  jobId: string;
  subjectId: string;
  target: StorageCleanupTargetInput;
  execution: CleanupExecutionBinding;
  transaction<Result>(run: (tx: Transaction) => Promise<Result>): Promise<Result>;
  executor(tx: Transaction): SqlExecutor;
  /**
   * Ports retain exclusive ownership of the captured destination throughout this call.
   * They must bound their I/O lifecycle and surface uncertain cleanup on expiry.
   */
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/**
 * Resume one admitted probe's cleanup. Caller cancellation never interrupts cleanup.
 * Active or uncertain uploads remain blocked by the journal's drain proof.
 * A failed transaction or external operation leaves the durable job available for recovery.
 * An existing completed receipt is recovery evidence, not a fresh readiness measurement.
 */
export async function cleanupStorageProbe<Transaction>(
  input: ProbeCleanupOptions<Transaction>,
): Promise<void> {
  const options = { ...input, target: { ...input.target }, execution: { ...input.execution } };
  const journal = (tx: Transaction) =>
    new StorageCleanupJournal(options.executor(tx), options.dialect, options.namespace);
  const executions = (tx: Transaction) =>
    new CleanupExecutionJournal(options.executor(tx), options.dialect, options.namespace);
  const inspect = () =>
    options.transaction(async (tx) => {
      const store = journal(tx);
      const job = await store.get(options.jobId);
      if (options.execution.jobId !== job.id || options.execution.backendBinding !== options.target.binding)
        throw new Error('Storage probe execution does not match cleanup');
      if (job.phase !== 'complete') await executions(tx).assertOwned(options.execution);
      else {
        const execution = await executions(tx).read(options.execution);
        if (!execution || execution.status === 'unconfirmed')
          throw new Error('Completed probe requires its confirmed execution identity');
      }
      const backend = await new StorageBackendRegistry(
        options.executor(tx),
        options.dialect,
        options.namespace,
      ).get(options.target.backendId);
      if (!backend || backend.binding !== options.target.binding)
        throw new Error('Storage probe backend binding does not match');
      if (job.subjectId !== options.subjectId || !/^storage-probe:[0-9a-f-]{36}$/.test(job.subjectId))
        throw new Error('Storage probe cleanup subject does not match');
      const page = await store.listCollectors(job.id);
      const collector = page.collectors[0];
      if (
        page.cursor !== null ||
        page.collectors.length !== 1 ||
        !collector ||
        collector.kind !== 'inventory' ||
        collector.match !== 'key' ||
        collector.scope !== options.target.key ||
        collector.backendIds.length !== 1 ||
        collector.backendIds[0] !== options.target.backendId
      )
        throw new Error('Storage probe cleanup requires its exact captured target');
      return { job, collector };
    });
  // A probe owns one immutable key. Repeated recreation means ownership is unproven.
  let verificationPasses = 0;
  while (true) {
    const { job, collector } = await inspect();
    if (job.phase === 'complete') return;
    if (job.phase === 'preparing' || job.phase === 'ready') {
      await options.transaction((tx) => executions(tx).transition(job.id, job.epoch, [options.execution]));
      continue;
    }
    if (job.phase === 'waiting') {
      await options.transaction(async (tx) => {
        await executions(tx).assertOwned(options.execution);
        return journal(tx).recordDrainedIntents(job.id, job.epoch, job.drainCursor);
      });
      continue;
    }
    if (job.phase === 'collecting' || job.phase === 'verifying') {
      if (!collector.complete) {
        if (job.phase === 'verifying' && ++verificationPasses > 2)
          throw new Error('Storage probe destination keeps reappearing during verification');
        const exists = await options.has(options.target.key);
        await options.transaction(async (tx) => {
          await executions(tx).assertOwned(options.execution);
          return journal(tx).recordCollectorPage({
            jobId: job.id,
            epoch: job.epoch,
            collectorId: collector.id,
            after: collector.cursor,
            next: null,
            targets: exists ? [options.target] : [],
          });
        });
      } else {
        await options.transaction((tx) => executions(tx).transition(job.id, job.epoch, [options.execution]));
      }
      continue;
    }
    const page = await options.transaction((tx) => journal(tx).pendingTargets(job.id, job.epoch));
    if (page.cursor !== null || page.tickets.length > 1)
      throw new Error('Storage probe cleanup contains unexpected targets');
    for (const ticket of page.tickets) {
      if (
        ticket.target.key !== options.target.key ||
        ticket.target.binding !== options.target.binding ||
        ticket.target.backendIds.length !== 1 ||
        ticket.target.backendIds[0] !== options.target.backendId
      )
        throw new Error('Storage probe deletion target does not match');
      await options.delete(ticket.target.key);
      await options.transaction((tx) => executions(tx).acknowledgeTarget(options.execution, ticket));
    }
    await options.transaction(async (tx) => {
      await executions(tx).assertOwned(options.execution);
      return journal(tx).beginVerification(job.id, job.epoch);
    });
  }
}
