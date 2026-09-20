import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageCleanup } from '../src/storage/local-cleanup';
import { LocalStorageReader, StorageReadCleanupError } from '../src/storage/local-reader';

const boundary = vi.hoisted(() => ({
  failClose: false,
  validating: undefined as (() => void) | undefined,
  files: [] as { fd: number }[],
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      boundary.files.push(file);
      return new Proxy(file, {
        get(target, property) {
          if (property === 'stat')
            return async (...statArgs: Parameters<typeof file.stat>) => {
              const result = await target.stat(...statArgs);
              boundary.validating?.();
              return result;
            };
          if (property === 'close')
            return async () => {
              await target.close();
              if (boundary.failClose) throw new Error('Close acknowledgement lost');
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

describe('captured local storage reads', () => {
  let directory: string;
  let root: string;
  let destination: string;
  let reader: LocalStorageReader;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sidedoor-reader-'));
    root = join(directory, 'storage');
    destination = join(directory, 'download');
    await mkdir(root);
    await writeFile(join(root, 'audio'), 'original audio');
    reader = await LocalStorageReader.restore((await LocalStorageCleanup.capture(root)).identity);
  });
  afterEach(async () => {
    boundary.failClose = false;
    boundary.validating = undefined;
    boundary.files = [];
    await rm(directory, { recursive: true, force: true });
  });

  it('reports unconfirmed cleanup after a complete byte copy', async () => {
    boundary.failClose = true;
    await expect(reader.copyToFile('audio', destination)).rejects.toBeInstanceOf(StorageReadCleanupError);
    expect(await readFile(destination, 'utf8')).toBe('original audio');
  });

  it('preserves a destination failure alongside failed source cleanup', async () => {
    await writeFile(destination, 'keep me');
    boundary.failClose = true;
    await expect(reader.copyToFile('audio', destination)).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: 'EEXIST' }), expect.any(StorageReadCleanupError)],
    });
    expect(await readFile(destination, 'utf8')).toBe('keep me');
  });

  it('copies exact bytes without overwriting an existing destination', async () => {
    await reader.copyToFile('audio', destination);
    expect(await readFile(destination, 'utf8')).toBe('original audio');
    await expect(reader.copyToFile('audio', destination)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination, 'utf8')).toBe('original audio');
  });

  it('rejects a replaced root even when its key exists', async () => {
    await rename(root, join(directory, 'old'));
    await mkdir(root);
    await writeFile(join(root, 'audio'), 'wrong backend');
    await expect(reader.copyToFile('audio', destination)).rejects.toThrow('Storage root changed');
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal, symbolic link files and symbolic link ancestors', async () => {
    await symlink(join(root, 'audio'), join(root, 'link'));
    await symlink(root, join(root, 'alias'));
    for (const key of ['../storage/audio', 'link', 'alias/audio']) {
      await expect(reader.copyToFile(key, destination)).rejects.toThrow();
    }
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails missing and cancelled reads without creating a destination', async () => {
    await expect(reader.copyToFile('missing', destination)).rejects.toThrow('Storage source does not exist');
    const controller = new AbortController();
    controller.abort();
    await expect(reader.copyToFile('audio', destination, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes acquired files when cancellation interrupts source validation', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancel source validation');
    boundary.validating = () => controller.abort(reason);
    await expect(reader.copyToFile('audio', destination, controller.signal)).rejects.toBe(reason);
    expect(boundary.files.length).toBeGreaterThan(0);
    expect(boundary.files.every((file) => file.fd === -1)).toBe(true);
    expect(await readFile(destination)).toHaveLength(0);
  });
});
