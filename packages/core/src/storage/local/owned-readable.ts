import { Readable } from 'node:stream';
import {
  copyOwnedBytesToFile,
  StorageReadCleanupError,
  type OwnedByteReader,
  type StorageCopyContent,
} from './owned-copy';

function ownReadable(stream: Readable): OwnedByteReader {
  const failures: unknown[] = stream.errored ? [stream.errored] : [];
  let failureCount = failures.length;
  const onError = (error: unknown) => {
    if (failures.includes(error)) return;
    failureCount = Math.min(Number.MAX_SAFE_INTEGER, failureCount + 1);
    if (failures.length < 8) failures.push(error);
  };
  stream.on('error', onError);
  const closed = stream.closed
    ? Promise.resolve()
    : new Promise<void>((resolve) => stream.once('close', resolve));
  let iterator: AsyncIterator<unknown> | undefined;
  let closing: Promise<void> | undefined;
  return {
    read: async () => {
      iterator ??= stream.iterator({ destroyOnReturn: false });
      const next = await iterator.next();
      if (next.done) return null;
      if (!(next.value instanceof Uint8Array)) throw new Error('Storage stream returned non-binary data');
      return next.value;
    },
    close: () => {
      closing ??= (async () => {
        try {
          stream.destroy();
        } catch (error) {
          onError(error);
        }
        await closed;
        // Node can set closed before its queued error/close events are emitted.
        await new Promise<void>((resolve) => process.nextTick(resolve));
        stream.off('error', onError);
        if (failureCount)
          throw new AggregateError(
            failures,
            `Storage stream closure includes ${failureCount} unresolved errors`,
          );
      })();
      return closing;
    },
  };
}

/** Observe every source before dispatch and close all sources concurrently on every exit. */
export async function withOwnedReadables<Result>(
  streams: readonly Readable[],
  run: () => Promise<Result>,
): Promise<Result> {
  const sources = [...new Set(streams)].map(ownReadable);
  let result!: Result;
  let primary: { error: unknown } | undefined;
  try {
    result = await run();
  } catch (error) {
    primary = { error };
  }
  const failures: unknown[] = [];
  const closing = Promise.all(
    sources.map(async (source) => {
      try {
        await source.close();
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: { error: unknown } | undefined;
  try {
    await Promise.race([
      closing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Storage stream cleanup timed out')), 1000);
      }),
    ]);
    if (failures.length) cleanup = { error: new AggregateError(failures, 'Storage source closure failed') };
  } catch (error) {
    cleanup = { error: new AggregateError([...failures, error], 'Storage source closure is unconfirmed') };
  } finally {
    clearTimeout(timer);
  }
  if (cleanup) {
    const error = new StorageReadCleanupError({ cause: cleanup.error });
    if (primary)
      throw new AggregateError([primary.error, error], 'Storage operation and source cleanup failed', {
        cause: error,
      });
    throw error;
  }
  if (primary) throw primary.error;
  return result;
}

/**
 * Own the actual Node stream returned by a transport, including late acquisition.
 * Streams must emit close after destruction. Error/close events cannot distinguish
 * every read failure from failed automatic destruction, so ambiguous stream errors
 * retain cleanup uncertainty. A transport needing finer proof should supply an
 * explicit OwnedByteReader to copyOwnedBytesToFile instead.
 */
export async function copyOwnedReadableToFile(options: {
  openSource: () => Promise<Readable>;
  destination: string;
  signal?: AbortSignal;
}): Promise<StorageCopyContent> {
  const { openSource, destination, signal } = options;
  return copyOwnedBytesToFile({
    destination,
    signal,
    openSource: async () => ownReadable(await openSource()),
  });
}
