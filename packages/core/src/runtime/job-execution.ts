import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  JobExecutionAdmissionConflict,
  JobExecutionJournal,
  type JobExecutionRecord,
} from './execution-journal';
import { canonicalJson } from './json';
import { ProcessExecutionError } from './process';
import { SemaphoreCleanupError } from './semaphore';
import { StorageReadCleanupError } from '../storage/owned-copy';
import { StorageProbeCleanupError } from '../storage/probe-errors';
import {
  planExecutionWorkspace,
  createExecutionWorkspace,
  removeExecutionWorkspace,
  type ExecutionWorkspacePlan,
} from '../storage/execution-workspace';
import type { SqlExecutor } from '../storage/sql';

export class JobExecutionCleanupError extends Error {
  constructor(options: ErrorOptions) {
    super('Job execution cleanup could not be confirmed', options);
    this.name = 'JobExecutionCleanupError';
  }
}

/** Shared ownership failures cannot be downgraded by an application's classifier. */
export function isJobExecutionCleanupFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    if (
      current instanceof JobExecutionCleanupError ||
      current instanceof StorageReadCleanupError ||
      current instanceof StorageProbeCleanupError ||
      current instanceof SemaphoreCleanupError ||
      (current instanceof ProcessExecutionError && current.code === 'cleanup_failed')
    )
      return true;
    if (current instanceof AggregateError) pending.push(...current.errors);
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return false;
}

/**
 * Every transaction callback must run in a fresh caller-owned Serializable transaction.
 * run must await its owned I/O or report uncertain cleanup. The workspace root and
 * location identity must be initialized before invocation. No automatic crash recovery.
 */
export async function runJobExecution<Database, Result>(options: {
  namespace: string;
  dialect: 'postgres' | 'sqlite';
  executorId: string;
  parentId: string;
  fingerprint: string;
  signal: AbortSignal;
  transaction: <Value>(
    operation: (database: Database) => Promise<Value>,
    signal?: AbortSignal,
  ) => Promise<Value>;
  executor: (database: Database) => SqlExecutor;
  validate: (database: Database) => Promise<boolean>;
  isCleanupFailure: (error: unknown) => boolean;
  workspace?: { root: string; locationId: string };
  run: (context: { markCleanupUnconfirmed: () => void; directory?: string }) => Promise<Result>;
}): Promise<Result | undefined> {
  const {
    namespace,
    dialect,
    executorId,
    parentId,
    fingerprint,
    signal,
    transaction,
    executor,
    validate,
    isCleanupFailure,
    run,
  } = options;
  const workspaceOptions = options.workspace ? { ...options.workspace } : undefined;
  const binding = { id: randomUUID(), parentId, fingerprint, executorId };
  signal.throwIfAborted();
  const workspace: ExecutionWorkspacePlan | undefined = workspaceOptions
    ? await planExecutionWorkspace(workspaceOptions.root, workspaceOptions.locationId, binding.id)
    : undefined;
  const journal = (database: Database) => new JobExecutionJournal(executor(database), dialect, namespace);
  const read = () => transaction((database) => journal(database).read(binding));
  async function confirm(
    operation: (value: JobExecutionJournal) => Promise<void>,
    matches: (record: JobExecutionRecord) => boolean,
  ) {
    try {
      await transaction((database) => operation(journal(database)));
    } catch (error) {
      try {
        if (matches(await read())) return;
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], 'Execution receipt could not be confirmed', {
          cause: recoveryError,
        });
      }
      throw error;
    }
  }
  let admitted: boolean;
  let recovered = false;
  while (true)
    try {
      admitted = await transaction(async (database) => {
        if (!(await validate(database))) return false;
        signal.throwIfAborted();
        await journal(database).begin(binding, workspace);
        return true;
      }, signal);
      break;
    } catch (error) {
      try {
        const record = await read();
        if (
          record.status !== 'active' ||
          canonicalJson(record.workspace ?? null) !== canonicalJson(workspace ?? null)
        )
          throw new Error('Execution admission does not match', { cause: error });
        admitted = true;
        recovered = true;
        break;
      } catch (recoveryError) {
        const blocker = await transaction(
          (database) => journal(database).blockingStatus(parentId, fingerprint),
          signal,
        );
        if (blocker === 'active') {
          await delay(25, undefined, { signal });
          continue;
        }
        if (error instanceof JobExecutionAdmissionConflict && blocker === null) continue;
        throw new AggregateError([error, recoveryError], 'Execution admission could not be confirmed', {
          cause: recoveryError,
        });
      }
    }
  if (!admitted) return;
  let uncertain = false;
  let creationAttempted = false;
  let workspaceAttached = false;
  let started = false;
  let result: Result | undefined;
  let failure: { error: unknown } | undefined;
  try {
    signal.throwIfAborted();
    if (recovered && !(await transaction(validate, signal)))
      throw new Error('Execution is no longer eligible');
    let directory: string | undefined;
    if (workspace) {
      signal.throwIfAborted();
      creationAttempted = true;
      const created = await createExecutionWorkspace(workspace);
      await confirm(
        (value) => value.attachWorkspace(binding, created),
        (record) =>
          record.status === 'active' && canonicalJson(record.workspace ?? null) === canonicalJson(created),
      );
      workspaceAttached = true;
      directory = created.directory.root;
    }
    signal.throwIfAborted();
    started = true;
    result = await run({
      markCleanupUnconfirmed: () => {
        uncertain = true;
      },
      ...(directory ? { directory } : {}),
    });
  } catch (error) {
    failure = { error };
    uncertain ||= creationAttempted && !workspaceAttached;
    if (started && !uncertain) {
      try {
        uncertain = isJobExecutionCleanupFailure(error) || isCleanupFailure(error);
      } catch (classificationError) {
        uncertain = true;
        failure = {
          error: new AggregateError([error, classificationError], 'Execution cleanup classification failed', {
            cause: classificationError,
          }),
        };
      }
    }
  }
  if (!uncertain && workspace) {
    try {
      const current = await read();
      if (!current.workspace) throw new Error('Execution workspace disappeared before cleanup');
      if ('directory' in current.workspace)
        await removeExecutionWorkspace(current.workspace, workspace.locationId);
      else if (creationAttempted) throw new Error('Execution workspace creation could not be confirmed');
      // No creation was attempted for an unstarted cancellation. Its intent can be released.
      await confirm(
        (value) => value.releaseWorkspace(binding, current.workspace!),
        (record) => !record.workspace,
      );
    } catch (error) {
      uncertain = true;
      const cleanup = new JobExecutionCleanupError({ cause: error });
      failure = {
        error: failure
          ? new AggregateError([failure.error, cleanup], 'Execution and workspace cleanup failed', {
              cause: error,
            })
          : cleanup,
      };
    }
  }
  if (uncertain && !failure)
    failure = {
      error: new JobExecutionCleanupError({ cause: new Error('Execution reported unresolved effects') }),
    };
  if (uncertain && signal.aborted && failure) {
    failure = {
      error: new AggregateError(
        [failure.error, new JobExecutionCleanupError({ cause: failure.error })],
        'Cancelled execution has unresolved cleanup',
        { cause: failure.error },
      ),
    };
  }
  try {
    await confirm(
      (value) => (uncertain ? value.markCleanupUnconfirmed(binding) : value.settle(binding)),
      (record) => record.status === (uncertain ? 'cleanup-unconfirmed' : 'settled'),
    );
  } catch (error) {
    const cleanup = new JobExecutionCleanupError({ cause: error });
    failure = {
      error: failure
        ? new AggregateError([failure.error, cleanup], 'Execution and cleanup receipt failed', {
            cause: error,
          })
        : cleanup,
    };
  }
  if (failure) throw failure.error;
  return result;
}
