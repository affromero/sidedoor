import { ProcessRunner, ProcessExecutionError } from '../process/process';
import { RemoteOutputDecoder, RemoteProtocolError } from './remote-output';
import { RemoteOperationJournal, type RemoteOperation } from './remote-journal';
import { withPinnedSshConnection } from '../ssh/ssh-pin';
import { remoteRecoveryRequest } from './remote-requests';

export class RemoteCleanupUncertainError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly code:
      'transport_failed' | 'protocol_failed' | 'cleanup_failed' | 'insufficient_containment',
    options?: ErrorOptions,
  ) {
    super(`Remote cleanup is unconfirmed (${code})`, options);
  }
}

/** Explicitly cancels the recorded remote operation, including an operation still running there. */
export class RemoteOperationRecovery {
  constructor(
    private readonly journal: RemoteOperationJournal,
    private readonly runner = new ProcessRunner(),
  ) {}

  async recover(
    operation: RemoteOperation,
    options: {
      environment: Readonly<Record<string, string | undefined>>;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const expected = await this.journal.current(structuredClone(operation));
    if (!expected) return;
    let confirmed = false;
    try {
      await withPinnedSshConnection(
        { connection: expected.connection, remoteUser: expected.remoteUser, hostKey: expected.hostKey },
        async (connection) => {
          const decoder = new RemoteOutputDecoder({
            ...expected,
            maxOutputBytes: 65536,
            maxDiagnosticBytes: 65536,
          });
          let transportError: unknown;
          let diagnostics = '';
          try {
            for await (const chunk of this.runner.stream({
              ...remoteRecoveryRequest({
                ...expected,
                connection,
                transportEnvironment: options.environment,
                signal: options.signal,
              }),
              maxOutputBytes: 1024 * 1024,
            })) {
              for (const output of decoder.push(chunk)) {
                if (output.channel !== 'transport-stderr') throw new RemoteProtocolError('protocol_failed');
                diagnostics += output.text;
              }
            }
          } catch (error) {
            transportError = error;
            if (error instanceof ProcessExecutionError)
              error.diagnostics = { stdout: '', stderr: diagnostics };
          }
          if (transportError instanceof RemoteProtocolError) throw transportError;
          const outcome = decoder.finish({ error: transportError });
          if (!outcome.cleanup) {
            throw new RemoteCleanupUncertainError(
              expected.operationId,
              outcome.failures.includes('cleanup_failed') ? 'cleanup_failed' : 'transport_failed',
              { cause: transportError },
            );
          }
          confirmed = await this.journal.acknowledge(expected, {
            operationId: outcome.cleanup.operationId,
            remoteUser: outcome.cleanup.remoteUser,
            operationRoot: outcome.cleanup.operationRoot,
            hostKey: expected.hostKey,
            containment: outcome.cleanup.containment,
          });
          if (!confirmed)
            throw new RemoteCleanupUncertainError(expected.operationId, 'insufficient_containment');
          if (transportError !== undefined) throw transportError;
          if (outcome.cleanup.exitCode !== 0 || outcome.failures.length)
            throw new ProcessExecutionError('exit_failed', outcome.cleanup.exitCode);
        },
      );
    } catch (error) {
      if (confirmed) throw error;
      const failure =
        error instanceof RemoteCleanupUncertainError
          ? error
          : new RemoteCleanupUncertainError(
              expected.operationId,
              error instanceof RemoteProtocolError ? 'protocol_failed' : 'transport_failed',
              { cause: error },
            );
      try {
        await this.journal.uncertain(expected, failure.code);
      } catch (journalError) {
        throw new AggregateError([failure, journalError], 'Remote recovery and journal persistence failed', {
          cause: journalError,
        });
      }
      throw failure;
    }
  }
}
