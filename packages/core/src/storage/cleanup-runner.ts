import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CleanupExecutionJournal, type CleanupExecutionBinding } from './cleanup-execution';
import { StorageCleanupJournal } from './cleanup-journal';
import type { StorageCleanupCollectorRecord, StorageCleanupTargetInput } from './cleanup-state';
import type { SqlExecutor } from './sql';

export interface StorageCleanupCollectionPage {
  targets: StorageCleanupTargetInput[];
  next: string | null;
}

export interface StorageCleanupBackendPort {
  backendId: string;
  binding: string;
  collect(
    collector: StorageCleanupCollectorRecord,
    signal: AbortSignal,
  ): Promise<StorageCleanupCollectionPage>;
  delete(key: string, signal: AbortSignal): Promise<void>;
}

export interface StorageCleanupRunnerOptions<Transaction> {
  namespace: string;
  dialect: 'postgres' | 'sqlite';
  jobId: string;
  executorId?: string;
  signal?: AbortSignal;
  transaction<Result>(run: (transaction: Transaction) => Promise<Result>): Promise<Result>;
  executor(transaction: Transaction): SqlExecutor;
  ports: readonly StorageCleanupBackendPort[];
}

/**
 * Resume one fully admitted cleanup while the caller retains exclusive locks for every binding.
 * Any failed external operation leaves its execution unresolved, so a successor cannot guess
 * whether a delete reached the backend.
 */
export async function runStorageCleanup<Transaction>(
  input: StorageCleanupRunnerOptions<Transaction>,
): Promise<void> {
  const namespace = z.string().min(1).max(200).parse(input.namespace);
  const jobId = z.uuid().parse(input.jobId);
  const executorId = z.uuid().parse(input.executorId ?? randomUUID());
  const ports = [...input.ports];
  if (!ports.length) throw new Error('Storage cleanup requires at least one backend port');
  const byBackend = new Map(ports.map((port) => [port.backendId, port]));
  const byBinding = new Map(ports.map((port) => [port.binding, port]));
  if (byBackend.size !== ports.length) throw new Error('Storage cleanup backend ports must be unique');
  const signal = input.signal ?? new AbortController().signal;
  const journal = (transaction: Transaction) =>
    new StorageCleanupJournal(input.executor(transaction), input.dialect, namespace);
  const executions = (transaction: Transaction) =>
    new CleanupExecutionJournal(input.executor(transaction), input.dialect, namespace);
  const bindings: CleanupExecutionBinding[] = [...byBinding].map(([backendBinding]) => ({
    executionId: randomUUID(),
    executorId,
    jobId,
    backendBinding,
  }));
  await input.transaction(async (transaction) => {
    for (const binding of bindings) await executions(transaction).begin(binding);
  });
  let externalStarted = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const snapshot = await input.transaction(async (transaction) => {
        const store = journal(transaction);
        const job = await store.get(jobId);
        const collectors = [];
        let after: string | null = null;
        do {
          const page = await store.listCollectors(jobId, after);
          collectors.push(...page.collectors);
          after = page.cursor;
        } while (after !== null);
        return { job, collectors };
      });
      const { job, collectors } = snapshot;
      if (job.phase === 'complete') break;
      if (job.phase === 'preparing' || job.phase === 'ready') {
        await input.transaction((transaction) =>
          executions(transaction).transition(job.id, job.epoch, bindings),
        );
        continue;
      }
      if (job.phase === 'waiting') {
        await input.transaction((transaction) =>
          journal(transaction).recordDrainedIntents(job.id, job.epoch, job.drainCursor),
        );
        continue;
      }
      if (job.phase === 'collecting' || job.phase === 'verifying') {
        const collector = collectors.find((candidate) => !candidate.complete);
        if (!collector) {
          await input.transaction((transaction) =>
            executions(transaction).transition(job.id, job.epoch, bindings),
          );
          continue;
        }
        const port = collector.backendIds.map((id) => byBackend.get(id)).find(Boolean);
        if (!port) throw new Error('Storage cleanup collector has no retained backend port');
        externalStarted = true;
        const page = await port.collect(collector, signal);
        if (page.targets.length > 1000) throw new Error('Storage cleanup backend page exceeds its bound');
        await input.transaction((transaction) =>
          journal(transaction).recordCollectorPage({
            jobId: job.id,
            epoch: job.epoch,
            collectorId: collector.id,
            after: collector.cursor,
            next: page.next,
            targets: page.targets,
          }),
        );
        continue;
      }
      if (job.phase !== 'deleting') throw new Error('Storage cleanup reached an unsupported phase');
      let after: string | null = null;
      do {
        const page = await input.transaction((transaction) =>
          journal(transaction).pendingTargets(job.id, job.epoch, after),
        );
        for (const ticket of page.tickets) {
          const port = byBinding.get(ticket.target.binding);
          if (!port) throw new Error('Storage cleanup target has no retained backend port');
          externalStarted = true;
          await port.delete(ticket.target.key, signal);
          await input.transaction((transaction) =>
            executions(transaction).acknowledgeTarget(
              bindings.find((binding) => binding.backendBinding === ticket.target.binding)!,
              ticket,
            ),
          );
        }
        after = page.cursor;
      } while (after !== null);
      await input.transaction((transaction) => journal(transaction).beginVerification(job.id, job.epoch));
    }
    await input.transaction(async (transaction) => {
      for (const binding of bindings) await executions(transaction).settle(binding);
    });
  } catch (error) {
    await input
      .transaction(async (transaction) => {
        for (const binding of bindings) {
          if (externalStarted) await executions(transaction).markUnconfirmed(binding);
          else await executions(transaction).settle(binding);
        }
      })
      .catch((settlementError) => {
        throw new AggregateError(
          [error, settlementError],
          'Storage cleanup failed and execution settlement could not be recorded',
          { cause: settlementError },
        );
      });
    throw error;
  }
}
