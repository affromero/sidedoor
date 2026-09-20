export { abortable } from './abort';
export { readResponseText, readResponseBytes, ResponseBodyTooLargeError } from './response';

export interface StreamGuard {
  /** Throw when the original authorization is no longer valid. */
  validate(): undefined;
  release(): void | Promise<void>;
}

/**
 * Abort before queuing iterator closure behind a pending read. The lazy source
 * must honor its signal and finish owned cleanup before settling. Classify
 * cleanup errors explicitly so cancellation itself does not make return fail.
 */
export function interruptibleStream<T>(
  open: (signal: AbortSignal) => AsyncGenerator<T>,
  options: { signal?: AbortSignal; isCleanupError: (error: unknown) => boolean },
): AsyncGenerator<T> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  async function* owned(): AsyncGenerator<T> {
    signal.throwIfAborted();
    yield* open(signal);
  }
  const iterator = owned();
  const hasCleanup = (error: unknown, seen = new Set<unknown>()): boolean => {
    if (seen.has(error)) return false;
    seen.add(error);
    return (
      options.isCleanupError(error) ||
      (error instanceof AggregateError && error.errors.some((nested) => hasCleanup(nested, seen))) ||
      (error instanceof Error && error.cause !== undefined && hasCleanup(error.cause, seen))
    );
  };
  let cleanupFailure: unknown;
  const next = iterator.next.bind(iterator);
  const close = iterator.return.bind(iterator);
  const fail = iterator.throw.bind(iterator);
  iterator.next = (...args) =>
    next(...args).catch((error: unknown) => {
      if (hasCleanup(error)) cleanupFailure = error;
      throw error;
    });
  iterator.return = async (value) => {
    controller.abort();
    const result = await close(value);
    if (cleanupFailure) throw cleanupFailure;
    return result;
  };
  iterator.throw = async (error) => {
    controller.abort(error);
    try {
      return await fail(error);
    } catch (failure) {
      const cleanup = cleanupFailure ?? (hasCleanup(failure) ? failure : undefined);
      if (cleanup && cleanup !== error)
        throw new AggregateError([error, cleanup], 'Stream interruption and cleanup failed', {
          cause: failure,
        });
      throw failure;
    }
  };
  return iterator;
}

/**
 * Preserve backpressure and revalidate each chunk before exposing its bytes.
 * The source must settle cancellation after stopping its I/O. Resource release
 * waits for that acknowledgement so cleanup cannot race an active upstream.
 */
export function guardStream<Chunk>(source: ReadableStream<Chunk>, guard: StreamGuard): ReadableStream<Chunk> {
  const reader = source.getReader();
  let cancelled = false;
  let disposal: Promise<void> | undefined;
  function validate(): void {
    const result: unknown = guard.validate();
    if (result !== undefined) {
      // Observe invalid asynchronous validators without permitting their bytes.
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('Stream validation must be synchronous and return undefined');
    }
  }
  function dispose(cancel: boolean, reason?: unknown): Promise<void> {
    disposal ??= (async () => {
      try {
        if (cancel) await reader.cancel(reason);
      } finally {
        try {
          reader.releaseLock();
        } finally {
          await guard.release();
        }
      }
    })();
    return disposal;
  }
  return new ReadableStream<Chunk>(
    {
      async pull(controller) {
        try {
          validate();
          const result = await reader.read();
          if (cancelled) return;
          validate();
          if (result.done) {
            await dispose(false);
            if (!cancelled) controller.close();
            return;
          }
          controller.enqueue(result.value);
        } catch (error) {
          if (cancelled) return;
          let failure = error;
          try {
            await dispose(true, error);
          } catch (cleanupError) {
            failure = new AggregateError([error, cleanupError], 'Stream validation or cleanup failed');
          }
          if (!cancelled) controller.error(failure);
        }
      },
      async cancel(reason) {
        cancelled = true;
        await dispose(true, reason);
      },
    },
    { highWaterMark: 0 },
  );
}
