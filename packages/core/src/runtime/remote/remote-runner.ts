import { performance } from 'node:perf_hooks';
import { ProcessRunner, ProcessExecutionError } from '../process/process';
import { RemoteOperationJournal, type RemoteHostKey, type RemoteOperation } from './remote-journal';
import { RemoteOutputDecoder, RemoteProtocolError, type RemoteSessionOutput } from './remote-output';
import { acquirePinnedSshConnection, type PinnedSshConnection } from '../ssh/ssh-pin';
import { supervisedSessionRequest, type RemoteSessionRequest } from './remote-requests';
import { RemoteOperationRecovery, RemoteCleanupUncertainError } from './remote-recovery';

export interface RemoteExecutionRequest extends Omit<RemoteSessionRequest, 'operationId'> {
  remoteUser: string;
  operationRoot: string;
  hostKey: RemoteHostKey;
  consumer: { id: string; generation: number };
  maxDiagnosticBytes?: number;
}

function localCleanupFailed(error: unknown): boolean {
  if (error instanceof ProcessExecutionError && error.code === 'cleanup_failed') return true;
  return error instanceof AggregateError && error.errors.some(localCleanupFailed);
}

function finishOutput(decoder: RemoteOutputDecoder, transportError: { error: unknown } | undefined) {
  try {
    return decoder.finish({ error: transportError?.error });
  } catch (error) {
    if (transportError)
      throw new AggregateError([transportError.error, error], 'Remote transport and protocol failed', {
        cause: error,
      });
    throw error;
  }
}

/** Owns one execution attempt. Recovery may repeat, but execution is never replayed. */
export class RemoteSessionRunner {
  private readonly recovery: RemoteOperationRecovery;
  constructor(
    private readonly journal: RemoteOperationJournal,
    private readonly runner = new ProcessRunner(),
  ) {
    this.recovery = new RemoteOperationRecovery(journal, runner);
  }

  stream(request: RemoteExecutionRequest): AsyncGenerator<RemoteSessionOutput, void, unknown> {
    const snapshot: RemoteExecutionRequest = {
      ...request,
      connection: { ...request.connection },
      hostKey: { ...request.hostKey },
      consumer: { ...request.consumer },
      files: [...request.files],
      args: request.args.map((arg) => (typeof arg === 'string' ? arg : { ...arg })),
      transportEnvironment: { ...request.transportEnvironment },
      remoteEnvironment: { ...request.remoteEnvironment },
      remoteEnvironmentKeys: [...request.remoteEnvironmentKeys],
      input: request.input === undefined ? undefined : Buffer.from(request.input),
    };
    const cancellation = new AbortController();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const settled = new Promise<void>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    void settled.catch(() => undefined);
    let started = false;
    const stream = this.execute(snapshot, cancellation.signal, { resolve, reject });
    const next = stream.next.bind(stream);
    const finish = stream.return.bind(stream);
    const fail = stream.throw.bind(stream);
    stream.next = (...args: [] | [unknown]) => {
      started = true;
      return next(...args);
    };
    stream.return = async (value) => {
      cancellation.abort(new Error('Remote stream closed'));
      if (!started) resolve();
      const results = await Promise.allSettled([finish(value), started ? settled : Promise.resolve()]);
      if (results[1].status === 'rejected') throw results[1].reason;
      if (results[0].status === 'rejected') throw results[0].reason;
      return results[0].value;
    };
    stream.throw = async (error) => {
      cancellation.abort(error);
      if (!started) resolve();
      const results = await Promise.allSettled([fail(error), started ? settled : Promise.resolve()]);
      if (results[1].status === 'rejected')
        throw new AggregateError(
          [error, results[1].reason],
          'Remote stream interruption and cleanup failed',
          { cause: results[1].reason },
        );
      throw error;
    };
    return stream;
  }

  private async *execute(
    request: RemoteExecutionRequest,
    cancellation: AbortSignal,
    settled: { resolve(): void; reject(error: unknown): void },
  ): AsyncGenerator<RemoteSessionOutput, void, unknown> {
    const started = performance.now();
    const timeout = request.timeoutMs ?? 600_000;
    const maximum = request.maxOutputBytes ?? 16 * 1024 * 1024;
    const diagnosticMaximum = request.maxDiagnosticBytes ?? 16 * 1024 * 1024;
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      cancellation,
      deadline.signal,
      ...(request.signal ? [request.signal] : []),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let operation: RemoteOperation | undefined;
    let pin: PinnedSshConnection | undefined;
    let admissionAttempted = false;
    let confirmed = false;
    let primary: { error: unknown } | undefined;
    try {
      if (
        !Number.isSafeInteger(timeout) ||
        timeout < 1 ||
        timeout > 86_400_000 ||
        ![maximum, diagnosticMaximum].every((value) => Number.isSafeInteger(value) && value > 0) ||
        !Number.isSafeInteger(maximum * 2 + diagnosticMaximum + 65536)
      )
        throw new Error('Invalid remote execution limits');
      signal.throwIfAborted();
      timer = setTimeout(() => deadline.abort(new Error('Remote operation timed out')), timeout);
      operation = await this.journal.register({
        connection: request.connection,
        hostKey: request.hostKey,
        remoteUser: request.remoteUser,
        operationRoot: request.operationRoot,
        consumer: request.consumer,
        maximumLifetimeMs: timeout + 60_000,
      });
      signal.throwIfAborted();
      pin = await acquirePinnedSshConnection(request);
      const prepared = await supervisedSessionRequest(
        {
          ...request,
          operationId: operation.operationId,
          connection: pin.connection,
          signal,
        },
        () => Math.floor(timeout - (performance.now() - started)),
      );
      signal.throwIfAborted();
      const remaining = Math.floor(timeout - (performance.now() - started));
      if (remaining < 1) throw new Error('Remote operation deadline expired');
      // Both clocks receive only the budget remaining after local preparation.
      prepared.timeoutMs = remaining;
      prepared.maxOutputBytes = maximum * 2 + diagnosticMaximum + 65536;
      admissionAttempted = true;
      await this.journal.connecting(operation);
      signal.throwIfAborted();
      const decoder = new RemoteOutputDecoder({
        ...operation,
        maxOutputBytes: maximum,
        maxDiagnosticBytes: diagnosticMaximum,
      });
      let transportError: { error: unknown } | undefined;
      try {
        for await (const chunk of this.runner.stream(prepared)) {
          for (const output of decoder.push(chunk)) yield output;
        }
      } catch (error) {
        transportError = { error };
      }
      const outcome = finishOutput(decoder, transportError);
      if (transportError?.error instanceof ProcessExecutionError)
        transportError.error.remoteFailureCodes = [...outcome.failures];
      if (outcome.cleanup)
        confirmed = await this.journal.acknowledge(operation, {
          ...outcome.cleanup,
          hostKey: operation.hostKey,
        });
      if (transportError) throw transportError.error;
      if (!confirmed) throw new RemoteProtocolError('protocol_failed');
      if (outcome.failures.length || outcome.cleanup?.exitCode !== 0) {
        const failure = new ProcessExecutionError('exit_failed', outcome.cleanup?.exitCode ?? null);
        failure.remoteFailureCodes = [...outcome.failures];
        throw failure;
      }
    } catch (error) {
      primary = { error };
      throw error;
    } finally {
      clearTimeout(timer);
      await this.close(operation, pin, admissionAttempted, confirmed, request, primary).then(
        settled.resolve,
        (error) => {
          settled.reject(error);
          throw error;
        },
      );
    }
  }

  private async close(
    operation: RemoteOperation | undefined,
    pin: PinnedSshConnection | undefined,
    admissionAttempted: boolean,
    confirmed: boolean,
    request: RemoteExecutionRequest,
    primary: { error: unknown } | undefined,
  ): Promise<void> {
    let cleanup: { error: unknown } | undefined;
    try {
      if (operation && !confirmed) {
        if (!admissionAttempted) await this.journal.discardUnstarted(operation);
        else {
          await this.journal.uncertain(operation, 'transport_failed');
          if (localCleanupFailed(primary?.error))
            throw new RemoteCleanupUncertainError(operation.operationId, 'cleanup_failed', {
              cause: primary?.error,
            });
          await this.recovery.recover(operation, { environment: request.transportEnvironment });
        }
      }
    } catch (error) {
      cleanup = { error };
    }
    try {
      await pin?.release(cleanup ?? primary);
    } catch (error) {
      cleanup = { error };
    }
    if (!cleanup) return;
    if (primary)
      throw new AggregateError([primary.error, cleanup.error], 'Remote execution and cleanup failed', {
        cause: cleanup.error,
      });
    throw cleanup.error;
  }
}
