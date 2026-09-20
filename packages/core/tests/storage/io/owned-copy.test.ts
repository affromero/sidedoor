import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyOwnedBytesToFile,
  StorageReadCleanupError,
  type OwnedByteReader,
} from '../../../src/storage/local/owned-copy';

const boundary = vi.hoisted(() => ({
  partial: false,
  zero: false,
  failClose: false,
  holdOpen: false,
  holdWrite: false,
  files: [] as { fd: number }[],
  opened: undefined as (() => void) | undefined,
  writing: undefined as (() => void) | undefined,
  releaseOpen: undefined as (() => void) | undefined,
  releaseWrite: undefined as (() => void) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      boundary.files.push(file);
      if (boundary.holdOpen)
        await new Promise<void>((resolve) => {
          boundary.releaseOpen = resolve;
          boundary.opened?.();
        });
      return new Proxy(file, {
        get(target, property) {
          if (property === 'write')
            return async (buffer: Uint8Array, offset: number, length: number, position: number | null) => {
              if (boundary.zero) return { bytesWritten: 0, buffer };
              if (boundary.holdWrite)
                await new Promise<void>((resolve) => {
                  boundary.releaseWrite = resolve;
                  boundary.writing?.();
                });
              return target.write(buffer, offset, boundary.partial ? Math.min(2, length) : length, position);
            };
          if (property === 'close')
            return async () => {
              await target.close();
              if (boundary.failClose) throw new Error('Destination close failed');
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

describe('owned byte copying', () => {
  let directory: string;
  let destination: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sidedoor-copy-'));
    destination = join(directory, 'output');
  });
  afterEach(async () => {
    boundary.partial = boundary.zero = boundary.failClose = false;
    boundary.holdOpen = boundary.holdWrite = false;
    boundary.releaseOpen?.();
    boundary.releaseWrite?.();
    boundary.opened = boundary.writing = boundary.releaseOpen = boundary.releaseWrite = undefined;
    boundary.files = [];
    await rm(directory, { recursive: true, force: true });
  });
  function source(bytes = Buffer.from('binary\0bytes')) {
    let delivered = false;
    return {
      read: async () => {
        if (delivered) return null;
        delivered = true;
        return bytes;
      },
      close: async () => {},
    };
  }
  it('completes partial destination writes without losing or duplicating bytes', async () => {
    boundary.partial = true;
    const copied = await copyOwnedBytesToFile({ destination, openSource: async () => source() });
    expect(await readFile(destination)).toEqual(Buffer.from('binary\0bytes'));
    expect(copied).toEqual({ bytes: 12, sha256: createHash('sha256').update('binary\0bytes').digest('hex') });
  });
  it('returns the empty file digest only after confirmed closure', async () => {
    let closed = false;
    expect(
      await copyOwnedBytesToFile({
        destination,
        openSource: async () => ({
          read: async () => null,
          close: async () => {
            closed = true;
          },
        }),
      }),
    ).toEqual({ bytes: 0, sha256: createHash('sha256').digest('hex') });
    expect(closed).toBe(true);
    expect(boundary.files[0]?.fd).toBe(-1);
    expect(await readFile(destination)).toHaveLength(0);
  });
  it('hashes detached bytes even when the source mutates its chunk during a write', async () => {
    const bytes = Buffer.from('original');
    boundary.holdWrite = true;
    boundary.writing = () => {
      bytes.fill(0);
      boundary.holdWrite = false;
      boundary.releaseWrite!();
    };
    expect(await copyOwnedBytesToFile({ destination, openSource: async () => source(bytes) })).toEqual({
      bytes: 8,
      sha256: createHash('sha256').update('original').digest('hex'),
    });
    expect(await readFile(destination, 'utf8')).toBe('original');
  });
  it('does not return copied-byte proof when cancellation occurs during source closure', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled while closing source');
    await expect(
      copyOwnedBytesToFile({
        destination,
        signal: controller.signal,
        openSource: async () => ({
          ...source(),
          close: async () => {
            controller.abort(reason);
          },
        }),
      }),
    ).rejects.toBe(reason);
    expect(boundary.files[0]?.fd).toBe(-1);
  });
  it('does not return copied-byte proof when a completed destination fails to close', async () => {
    boundary.failClose = true;
    await expect(
      copyOwnedBytesToFile({ destination, openSource: async () => source() }),
    ).rejects.toBeInstanceOf(StorageReadCleanupError);
  });
  it('rejects zero-byte writes and closes both owned resources', async () => {
    boundary.zero = true;
    let closed = false;
    await expect(
      copyOwnedBytesToFile({
        destination,
        openSource: async () => ({
          ...source(),
          close: async () => {
            closed = true;
          },
        }),
      }),
    ).rejects.toThrow('valid write progress');
    expect(closed).toBe(true);
    expect(boundary.files[0]?.fd).toBe(-1);
  });
  it('preserves the primary error and both close failures', async () => {
    boundary.failClose = true;
    const primary = new Error('Source read failed');
    const sourceClose = new Error('Source close failed');
    await expect(
      copyOwnedBytesToFile({
        destination,
        openSource: async () => ({
          read: async () => {
            throw primary;
          },
          close: async () => {
            throw sourceClose;
          },
        }),
      }),
    ).rejects.toMatchObject({
      errors: [
        primary,
        {
          name: 'StorageReadCleanupError',
          cause: { errors: [sourceClose, expect.objectContaining({ message: 'Destination close failed' })] },
        },
      ],
    });
  });
  it('cancels a pending read and confirms its release before returning', async () => {
    const controller = new AbortController();
    const reason = new Error('Copy cancelled');
    let finishRead: ((value: null) => void) | undefined;
    let released = false;
    const running = copyOwnedBytesToFile({
      destination,
      signal: controller.signal,
      openSource: async () => ({
        read: () =>
          new Promise<null>((resolve) => {
            finishRead = resolve;
            controller.abort(reason);
          }),
        close: async () => {
          finishRead?.(null);
          released = true;
        },
      }),
    });
    await expect(running).rejects.toBe(reason);
    expect(released).toBe(true);
  });
  it('reports unconfirmed cleanup and closes a source acquired after the cleanup deadline', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancel acquisition');
    let acquire: ((reader: OwnedByteReader) => void) | undefined;
    let closed = false;
    const running = copyOwnedBytesToFile({
      destination,
      signal: controller.signal,
      openSource: () =>
        new Promise<OwnedByteReader>((resolve) => {
          acquire = resolve;
          controller.abort(reason);
        }),
    });
    await expect(running).rejects.toMatchObject({ errors: [reason, expect.any(StorageReadCleanupError)] });
    acquire!({
      ...source(),
      close: async () => {
        closed = true;
      },
    });
    await expect.poll(() => closed).toBe(true);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('never replaces an existing destination when acquisition fails', async () => {
    await writeFile(destination, 'preserved');
    let released = false;
    await expect(
      copyOwnedBytesToFile({
        destination,
        openSource: async () => ({
          ...source(),
          close: async () => {
            released = true;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(released).toBe(true);
    expect(await readFile(destination, 'utf8')).toBe('preserved');
  });
  it('closes a destination acquired after cancellation and the cleanup deadline', async () => {
    const controller = new AbortController();
    const reason = new Error('Stop destination acquisition');
    boundary.holdOpen = true;
    boundary.opened = () => controller.abort(reason);
    await expect(
      copyOwnedBytesToFile({ destination, signal: controller.signal, openSource: async () => source() }),
    ).rejects.toMatchObject({ errors: [reason, expect.any(StorageReadCleanupError)] });
    expect(boundary.files[0]?.fd).not.toBe(-1);
    boundary.releaseOpen!();
    await expect.poll(() => boundary.files[0]?.fd).toBe(-1);
  });
  it('retains an unresolved write and closes its destination only after the write settles', async () => {
    const controller = new AbortController();
    const reason = new Error('Stop destination write');
    const bytes = Buffer.from('preserved bytes');
    boundary.holdWrite = true;
    boundary.writing = () => {
      bytes.fill(0);
      controller.abort(reason);
    };
    await expect(
      copyOwnedBytesToFile({ destination, signal: controller.signal, openSource: async () => source(bytes) }),
    ).rejects.toMatchObject({ errors: [reason, expect.any(StorageReadCleanupError)] });
    expect(boundary.files[0]?.fd).not.toBe(-1);
    boundary.releaseWrite!();
    await expect.poll(() => boundary.files[0]?.fd).toBe(-1);
    expect(await readFile(destination, 'utf8')).toBe('preserved bytes');
  });
  it('observes a late source close rejection after reporting cleanup uncertainty', async () => {
    const controller = new AbortController();
    let acquire: ((reader: OwnedByteReader) => void) | undefined;
    let closeAttempted = false;
    const running = copyOwnedBytesToFile({
      destination,
      signal: controller.signal,
      openSource: () =>
        new Promise<OwnedByteReader>((resolve) => {
          acquire = resolve;
          controller.abort();
        }),
    });
    await expect(running).rejects.toMatchObject({
      errors: [expect.any(Error), expect.any(StorageReadCleanupError)],
    });
    acquire!({
      ...source(),
      close: async () => {
        closeAttempted = true;
        throw new Error('Late close failed');
      },
    });
    await expect.poll(() => closeAttempted).toBe(true);
  });
  it('does not confirm cleanup while a read remains pending after source closure', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancel unresolved read');
    let finishRead: ((value: null) => void) | undefined;
    let closed = false;
    await expect(
      copyOwnedBytesToFile({
        destination,
        signal: controller.signal,
        openSource: async () => ({
          read: () =>
            new Promise<null>((resolve) => {
              finishRead = resolve;
              controller.abort(reason);
            }),
          close: async () => {
            closed = true;
          },
        }),
      }),
    ).rejects.toMatchObject({ errors: [reason, expect.any(StorageReadCleanupError)] });
    expect(closed).toBe(true);
    expect(boundary.files[0]?.fd).toBe(-1);
    finishRead!(null);
    expect(await readFile(destination)).toHaveLength(0);
  });
});
