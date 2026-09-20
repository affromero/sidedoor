import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageBackendRegistry, prepareStorageBackend } from './registry/backend-registry';
import { StorageCleanupJournal } from './cleanup/cleanup-journal';
import { prepareStorageCleanup } from './cleanup/cleanup-state';
import { StorageInstanceControl } from './sql/instance';
import { cleanupStorageProbe } from './cleanup/backends/probe-cleanup';
import type { SqlExecutor } from './sql/sql';
import { StorageWriteJournal, prepareStorageWrite } from './execution/write-journal';
import type { ReferenceSetAdmission, ReferenceSetWriter } from './execution/write-set';
import { CleanupExecutionJournal } from './cleanup/cleanup-execution';
import { StorageProbeCleanupError } from './probe-errors';

export interface StorageProbePort extends ReferenceSetWriter {
  /** Exact captured destination. Cleanup operations must bound their own I/O lifecycle. */
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}
export interface StorageProbeOptions<Transaction, Snapshot> {
  namespace: string;
  dialect: 'postgres' | 'sqlite';
  signal: AbortSignal;
  executorId: string;
  transaction<Result>(run: (tx: Transaction) => Promise<Result>): Promise<Result>;
  executor(tx: Transaction): SqlExecutor;
  captureAdmission(tx: Transaction): Promise<ReferenceSetAdmission<Snapshot>>;
  validateAdmission(tx: Transaction, admission: ReferenceSetAdmission<Snapshot>): Promise<void>;
  /** Retain exclusive ownership of this unique probe destination until this operation ends. */
  capturePort(): Promise<StorageProbePort>;
}

/** Journal admission before upload. No failed or ambiguous upload is silently retried. */
export async function runStorageProbe<Transaction, Snapshot>(
  input: StorageProbeOptions<Transaction, Snapshot>,
): Promise<{ cleanupJobId: string }> {
  const options = { ...input };
  options.signal.throwIfAborted();
  const writes = (tx: Transaction) =>
    new StorageWriteJournal(options.executor(tx), options.dialect, options.namespace);
  const cleanup = (tx: Transaction) =>
    new StorageCleanupJournal(options.executor(tx), options.dialect, options.namespace);
  const instance = (tx: Transaction) =>
    new StorageInstanceControl(options.executor(tx), options.dialect, options.namespace);
  const executions = (tx: Transaction) =>
    new CleanupExecutionJournal(options.executor(tx), options.dialect, options.namespace);
  const admission = await options.transaction(async (tx) => {
    const captured = structuredClone(await options.captureAdmission(tx));
    const current = await instance(tx).read();
    const scopes = z
      .array(
        z
          .object({
            subjectId: z.string().min(1).max(200),
            generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .min(2)
      .max(1000)
      .parse(captured.scopes);
    if (
      captured.instanceId !== current.instanceId ||
      new Set(scopes.map((scope) => scope.subjectId)).size !== scopes.length ||
      !scopes.some(
        (scope) => scope.subjectId === current.subjectId && scope.generation === current.generation,
      )
    )
      throw new Error('Storage probe admission does not match the current instance');
    return captured;
  });
  options.signal.throwIfAborted();
  const capturedPort = await options.capturePort();
  const port = {
    descriptor: structuredClone(capturedPort.descriptor),
    write: capturedPort.write.bind(capturedPort),
    has: capturedPort.has.bind(capturedPort),
    delete: capturedPort.delete.bind(capturedPort),
  };
  const backend = prepareStorageBackend(options.namespace, port.descriptor);
  const subjectId = `storage-probe:${randomUUID()}`;
  const target = {
    backendId: backend.id,
    binding: backend.binding,
    key: `storage-probes/${admission.instanceId}/${randomUUID()}.txt`,
  };
  const job = prepareStorageCleanup({ namespace: options.namespace, subjectId, generation: 0 });
  const execution = {
    executionId: randomUUID(),
    executorId: options.executorId,
    jobId: job.id,
    backendBinding: backend.binding,
  };
  const intents = [...admission.scopes, { subjectId, generation: 0 }].map((scope) =>
    prepareStorageWrite({ namespace: options.namespace, ...scope, target }),
  );
  async function validate(tx: Transaction) {
    options.signal.throwIfAborted();
    await options.validateAdmission(tx, structuredClone(admission));
    if ((await instance(tx).read()).instanceId !== admission.instanceId)
      throw new Error('Storage instance changed during the probe');
    for (const intent of intents.slice(0, admission.scopes.length))
      await writes(tx).assertWritable(intent, intent.generation);
    options.signal.throwIfAborted();
  }
  async function finish(kind: 'not_created' | 'unreferenced' | 'uncertain') {
    await options.transaction(async (tx) => {
      for (const intent of intents) await writes(tx).finish(intent, { kind });
    });
  }
  async function clean() {
    await cleanupStorageProbe({
      ...options,
      jobId: job.id,
      subjectId,
      target,
      execution,
      has: (key) => port.has(key),
      delete: (key) => port.delete(key),
    });
    try {
      await options.transaction((tx) => executions(tx).settle(execution));
    } catch (error) {
      try {
        const confirmed = await options.transaction(
          async (tx) =>
            (await executions(tx).read(execution))?.status === 'settled' &&
            (await cleanup(tx).get(job.id)).phase === 'complete',
        );
        if (confirmed) return;
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], 'Storage probe settlement could not be confirmed', {
          cause: recoveryError,
        });
      }
      throw error;
    }
  }
  try {
    await options.transaction(async (tx) => {
      await new StorageBackendRegistry(options.executor(tx), options.dialect, options.namespace).register(
        backend,
      );
      await validate(tx);
      for (const intent of intents) await writes(tx).begin(intent, intent.generation);
      await cleanup(tx).createJob(job);
      await cleanup(tx).registerCollectors(job.id, 0, [
        {
          id: 'probe',
          kind: 'inventory',
          backendIds: [backend.id],
          scope: target.key,
          match: 'key',
        },
      ]);
      await executions(tx).begin(execution);
    });
  } catch (error) {
    // This executor never started external I/O, even if admission committed remotely.
    // Reading the exact unique job distinguishes accepted admission from rollback.
    try {
      const accepted = await options.transaction(async (tx) => {
        const stored = await cleanup(tx).find(job.id);
        if (stored && stored.subjectId !== subjectId)
          throw new Error('Storage probe admission identity does not match');
        return stored !== null;
      });
      if (accepted) {
        await finish('not_created');
        await clean();
      }
    } catch (recoveryError) {
      throw new StorageProbeCleanupError(
        job.id,
        [error, recoveryError],
        'Storage probe admission recovery failed',
      );
    }
    throw error;
  }
  let started = false;
  try {
    await options.transaction(async (tx) => {
      await validate(tx);
      await executions(tx).assertOwned(execution);
    });
    options.signal.throwIfAborted();
    started = true;
    await port.write(target.key, Buffer.from('ok'), 'text/plain', options.signal);
  } catch (error) {
    try {
      await finish(started ? 'uncertain' : 'not_created');
      if (!started) await clean();
      else await options.transaction((tx) => executions(tx).markUnconfirmed(execution));
    } catch (recoveryError) {
      throw new StorageProbeCleanupError(
        job.id,
        [error, recoveryError],
        'Storage probe cleanup is unresolved',
      );
    }
    if (started)
      throw new StorageProbeCleanupError(job.id, [error], 'Storage probe upload outcome is unresolved');
    throw error;
  }
  try {
    await finish('unreferenced');
    await clean();
  } catch (error) {
    throw new StorageProbeCleanupError(job.id, [error], 'Storage probe cleanup is unresolved');
  }
  await options.transaction(validate);
  return { cleanupJobId: job.id };
}
