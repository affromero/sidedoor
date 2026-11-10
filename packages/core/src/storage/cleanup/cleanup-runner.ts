import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CleanupExecutionJournal, type CleanupExecutionBinding } from './cleanup-execution';
import { StorageCleanupJournal } from './cleanup-journal';
import { StorageBackendRegistry } from '../registry/backend-registry';
import type { StorageCleanupCollectorRecord, StorageCleanupTargetInput } from './cleanup-state';
import type { SqlExecutor } from '../sql/sql';

export interface StorageCleanupCollectionPage {
  targets: StorageCleanupTargetInput[];
  next: string | null;
}

export interface StorageCleanupBackendPort {
  backendId: string;
  binding: string;
  /** Resolve only after the read-only collection operation has fully settled. */
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
  const underLock = <Result>(run: (transaction: Transaction) => Promise<Result>) =>
    input.transaction(async (transaction) => {
      signal.throwIfAborted();
      const result = await run(transaction);
      signal.throwIfAborted();
      return result;
    });
  const transition = (id: string, epoch: number) =>
    underLock((transaction) => executions(transaction).transition(id, epoch, bindings));
  signal.throwIfAborted();
  const completed = await input.transaction(async (transaction) => {
    signal.throwIfAborted();
    const store = journal(transaction);
    const job = await store.get(jobId);
    if (job.phase === 'complete') {
      const registry = new StorageBackendRegistry(input.executor(transaction), input.dialect, namespace);
      const covered = new Set(bindings.map((binding) => binding.backendBinding));
      let cursor: string | null = null;
      do {
        const page = await store.listCollectors(jobId, cursor);
        for (const collector of page.collectors) {
          if (collector.backendIds.length !== 1)
            throw new Error('Storage cleanup requires one backend per collector');
          for (const id of collector.backendIds) {
            const backend = await registry.get(id);
            if (!backend || !covered.has(backend.binding))
              throw new Error('Completed cleanup requires every registered backend');
          }
        }
        cursor = page.cursor;
      } while (cursor !== null);
      for (const binding of bindings) {
        const execution = executions(transaction);
        if (!(await execution.hasConfirmedCompletion(jobId, binding.backendBinding)))
          throw new Error('Completed cleanup requires confirmed backend execution');
      }
      signal.throwIfAborted();
      return true;
    }
    for (const binding of bindings) await executions(transaction).begin(binding);
    return false;
  });
  if (completed) return;
  let unconfirmedBinding: string | null = null;
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
      if (collectors.some((collector) => collector.backendIds.length !== 1))
        throw new Error('Storage cleanup requires one backend per collector');
      if (job.phase === 'complete') break;
      if (job.phase === 'preparing' || job.phase === 'ready') {
        await transition(job.id, job.epoch);
        continue;
      }
      if (job.phase === 'waiting') {
        await underLock((transaction) =>
          journal(transaction).recordDrainedIntents(job.id, job.epoch, job.drainCursor),
        );
        continue;
      }
      if (job.phase === 'collecting' || job.phase === 'verifying') {
        const collector = collectors.find((candidate) => !candidate.complete);
        if (!collector) {
          await transition(job.id, job.epoch);
          continue;
        }
        const port = collector.backendIds.map((id) => byBackend.get(id)).find(Boolean);
        if (!port) throw new Error('Storage cleanup collector has no retained backend port');
        const binding = bindings.find((item) => item.backendBinding === port.binding);
        if (!binding) throw new Error('Storage cleanup collector has no execution binding');
        const revision = await underLock((transaction) =>
          executions(transaction).beginUnconfirmedOperation(binding, 'read'),
        );
        unconfirmedBinding = port.binding;
        signal.throwIfAborted();
        const page = await port.collect(collector, signal);
        signal.throwIfAborted();
        if (page.targets.length > 1000) throw new Error('Storage cleanup backend page exceeds its bound');
        await input.transaction(async (transaction) => {
          signal.throwIfAborted();
          await executions(transaction).confirmObservedIo(binding, revision);
          for (const binding of bindings) await executions(transaction).assertOwned(binding);
          signal.throwIfAborted();
          const recorded = await journal(transaction).recordCollectorPage({
            jobId: job.id,
            epoch: job.epoch,
            collectorId: collector.id,
            after: collector.cursor,
            next: page.next,
            targets: page.targets,
          });
          signal.throwIfAborted();
          return recorded;
        });
        unconfirmedBinding = null;
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
          const binding = bindings.find((item) => item.backendBinding === ticket.target.binding);
          if (!binding) throw new Error('Storage cleanup target has no execution binding');
          const revision = await underLock(async (transaction) => {
            await executions(transaction).authorizeTarget(binding, ticket);
            return executions(transaction).beginUnconfirmedOperation(binding, 'delete');
          });
          unconfirmedBinding = port.binding;
          signal.throwIfAborted();
          await port.delete(ticket.target.key, signal);
          signal.throwIfAborted();
          await input.transaction((transaction) =>
            executions(transaction).acknowledgeDispatchedTarget(binding, ticket, revision),
          );
          signal.throwIfAborted();
          unconfirmedBinding = null;
        }
        after = page.cursor;
      } while (after !== null);
      await underLock((transaction) => journal(transaction).beginVerification(job.id, job.epoch));
    }
    signal.throwIfAborted();
    await input.transaction(async (transaction) => {
      signal.throwIfAborted();
      for (const binding of bindings)
        if (!(await executions(transaction).hasSettled(jobId, binding.backendBinding, binding.executionId)))
          throw new Error('Completed cleanup requires confirmed backend execution');
      for (const binding of bindings) await executions(transaction).settle(binding);
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  } catch (error) {
    await input
      .transaction(async (transaction) => {
        for (const binding of bindings) {
          if (unconfirmedBinding === binding.backendBinding || signal.aborted)
            await executions(transaction).markUnconfirmed(binding);
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
