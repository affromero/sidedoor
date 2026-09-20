import { setTimeout as delay } from 'node:timers/promises';

export interface TaskLoopOptions {
  intervalMs: number;
  signal: AbortSignal;
  task: (signal: AbortSignal) => void | Promise<void>;
  onError: (error: unknown) => undefined;
}

/**
 * Run immediately, then wait after each completed pass. Tasks never overlap.
 * The caller owns cancellation and must await or observe this promise.
 * Abort stops scheduling and waits for active work to finish cooperatively.
 * A throwing error reporter terminates the loop by rejecting its promise.
 */
export async function runTaskLoop(options: TaskLoopOptions): Promise<void> {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1 || options.intervalMs > 2_147_483_647)
    throw new Error('Task interval must be an integer between 1 and 2147483647 milliseconds');
  while (!options.signal.aborted) {
    try {
      await options.task(options.signal);
    } catch (error) {
      if (!options.signal.aborted) options.onError(error);
    }
    if (options.signal.aborted) return;
    try {
      await delay(options.intervalMs, undefined, { signal: options.signal, ref: false });
    } catch (error) {
      if (!options.signal.aborted) throw error;
      return;
    }
  }
}
