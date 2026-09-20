import { mkdir, open } from 'node:fs/promises';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const requireNative = createRequire(import.meta.url);
let binding: typeof import('thesidedoor-flock') | undefined;
function lockFile(descriptor: number, shared: boolean): void {
  try {
    binding ??= requireNative('thesidedoor-flock') as typeof import('thesidedoor-flock');
  } catch (cause) {
    throw new Error(
      'Native file locking is unavailable. Install thesidedoor-flock with a working C++ compiler and node-gyp toolchain.',
      { cause },
    );
  }
  const { LOCK_SH, LOCK_EX, LOCK_NB } = binding.constants;
  binding.flock(descriptor, (shared ? LOCK_SH : LOCK_EX) | LOCK_NB);
}

export interface FileLockOptions {
  mode?: 'shared' | 'exclusive';
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class FileLockBusyError extends Error {
  readonly code = 'lock_busy';
  constructor() {
    super('The protected files are busy. Retry the operation.');
  }
}

/** Short synchronous commits only. Never wait on a lock while blocking the event loop. */
export function withSharedFileLockSync<Result>(
  path: string,
  operation: () => Result & (Result extends PromiseLike<unknown> ? never : unknown),
): Result {
  const release = acquireFileLockSync(path, 'shared');
  try {
    const result = operation();
    if (result instanceof Promise)
      throw new Error('Synchronous file lock callbacks must not return a promise');
    return result;
  } finally {
    release();
  }
}

/** Acquire immediately or fail with retryable contention. Always release in finally. */
export function acquireFileLockSync(path: string, mode: 'shared' | 'exclusive' = 'exclusive'): () => void {
  const anchor = resolve(path);
  mkdirSync(dirname(anchor), { recursive: true, mode: 0o700 });
  const descriptor = openSync(anchor, 'a', 0o600);
  try {
    try {
      lockFile(descriptor, mode === 'shared');
    } catch (error) {
      if (error instanceof Error && 'code' in error && ['EAGAIN', 'EWOULDBLOCK'].includes(String(error.code)))
        throw new FileLockBusyError();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      closeSync(descriptor);
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

/** The anchor must remain at a stable path outside any directory protected from deletion. */
export async function acquireFileLock(
  path: string,
  options: FileLockOptions = {},
): Promise<() => Promise<void>> {
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid file lock timeout');
  options.signal?.throwIfAborted();
  const anchor = resolve(path);
  await mkdir(dirname(anchor), { recursive: true, mode: 0o700 });
  const handle = await open(anchor, 'a', 0o600);
  try {
    const deadline = Date.now() + timeout;
    while (true) {
      options.signal?.throwIfAborted();
      try {
        lockFile(handle.fd, options.mode === 'shared');
        return () => handle.close();
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          !['EAGAIN', 'EWOULDBLOCK'].includes(String(error.code))
        )
          throw error;
        if (Date.now() >= deadline) throw new FileLockBusyError();
        await delay(10, undefined, { signal: options.signal });
      }
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function withFileLock<Result>(
  path: string,
  operation: () => Result | Promise<Result>,
  options: FileLockOptions = {},
): Promise<Result> {
  const release = await acquireFileLock(path, options);
  try {
    return await operation();
  } finally {
    await release();
  }
}
