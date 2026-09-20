/** Probe ownership remains unresolved even when the original transport error looks ordinary. */
export class StorageProbeCleanupError extends AggregateError {
  constructor(
    readonly cleanupJobId: string,
    errors: readonly unknown[],
    message: string,
  ) {
    super(errors, `${message} (${cleanupJobId})`, { cause: errors[0] });
    this.name = 'StorageProbeCleanupError';
  }
}
