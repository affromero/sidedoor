import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { abortable } from '../runtime/abort';

export class StorageReadCleanupError extends Error {
  constructor(options: ErrorOptions) {
    super('Storage read cleanup could not be confirmed', options);
    this.name = 'StorageReadCleanupError';
  }
}

export interface OwnedByteReader {
  read(): Promise<Uint8Array | null>;
  /** Stop pending reads and release the source. May run concurrently with read(). */
  close(): Promise<void>;
}

/** Evidence of copied bytes and confirmed handle closure, not an fsync durability guarantee. */
export interface StorageCopyContent {
  sha256: string;
  bytes: number;
}

/**
 * Own acquisition, sequential copying and explicit cleanup. openSource must clean
 * up its own partially acquired resources if it rejects. Failed copies leave
 * partial destination files for the caller. Cleanup timeout means uncertainty,
 * while late acquisitions and writes retain their eventual close continuations.
 */
export async function copyOwnedBytesToFile(options: {
  openSource: () => Promise<OwnedByteReader>;
  destination: string;
  signal?: AbortSignal;
}): Promise<StorageCopyContent> {
  const { openSource, destination, signal = new AbortController().signal } = options;
  const digest = createHash('sha256');
  let totalBytes = 0;
  signal.throwIfAborted();
  let source: Promise<OwnedByteReader> | undefined;
  let target: ReturnType<typeof open> | undefined;
  let reading: Promise<unknown> | undefined;
  let writing: Promise<unknown> | undefined;
  let primary: { error: unknown } | undefined;
  const settled = (work: Promise<unknown> | undefined) =>
    work?.then(
      () => undefined,
      () => undefined,
    );
  try {
    source = Promise.resolve().then(openSource);
    const reader = await abortable(source, signal);
    signal.throwIfAborted();
    target = open(destination, 'wx', 0o600);
    const file = await abortable(target, signal);
    while (true) {
      signal.throwIfAborted();
      const next = reader.read();
      reading = next;
      const value = await abortable(next, signal);
      signal.throwIfAborted();
      if (value === null) break;
      if (!(value instanceof Uint8Array) || value.byteLength === 0)
        throw new Error('Storage source returned invalid bytes');
      const bytes = Uint8Array.from(value);
      if (!Number.isSafeInteger(totalBytes + bytes.byteLength))
        throw new Error('Storage copy byte count exceeds its safe integer limit');
      for (let offset = 0; offset < bytes.byteLength;) {
        signal.throwIfAborted();
        const write = file.write(bytes, offset, bytes.byteLength - offset, null);
        writing = write;
        const { bytesWritten } = await abortable(write, signal);
        if (
          !Number.isSafeInteger(bytesWritten) ||
          bytesWritten <= 0 ||
          bytesWritten > bytes.byteLength - offset
        )
          throw new Error('Storage destination did not make valid write progress');
        offset += bytesWritten;
      }
      digest.update(bytes);
      totalBytes += bytes.byteLength;
    }
  } catch (error) {
    primary = { error };
  }

  // Start source closure before awaiting a pending read so cancellation can drain it.
  const sourceClose = source?.then(
    (reader) => reader.close(),
    () => undefined,
  );
  const targetClose = target?.then(
    async (file) => {
      await settled(writing);
      await file.close();
    },
    () => undefined,
  );
  const cleanup = Promise.allSettled([sourceClose, targetClose, settled(reading)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  try {
    const results = await Promise.race([
      cleanup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Storage read cleanup timed out')), 1000);
      }),
    ]);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (errors.length)
      cleanupFailure = { error: new AggregateError(errors, 'Storage resources could not be closed') };
  } catch (error) {
    cleanupFailure = { error };
  } finally {
    clearTimeout(timer);
  }
  if (cleanupFailure) {
    const error = new StorageReadCleanupError({ cause: cleanupFailure.error });
    if (primary)
      throw new AggregateError([primary.error, error], 'Storage read and cleanup failed', {
        cause: cleanupFailure.error,
      });
    throw error;
  }
  if (primary) throw primary.error;
  signal.throwIfAborted();
  return { sha256: digest.digest('hex'), bytes: totalBytes };
}
