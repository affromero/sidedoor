import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openExecutionLocation } from '../../../src/storage/execution/execution-location';
import { StorageReadCleanupError } from '../../../src/storage/local/owned-copy';

const boundary = vi.hoisted(() => ({ failClose: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (!String(args[0]).endsWith('/location.json')) return file;
      return new Proxy(file, {
        get(target, property) {
          if (property === 'close')
            return async () => {
              await target.close();
              if (boundary.failClose) throw new Error('Marker close acknowledgement lost');
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

describe('persistent execution location', () => {
  let parent: string;
  let root: string;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'sidedoor-location-'));
    root = join(parent, 'owned');
  });
  afterEach(async () => {
    boundary.failClose = false;
    await rm(parent, { recursive: true, force: true });
  });
  it('converges concurrent initialization and reopens the same private identity', async () => {
    const [first, second] = await Promise.all([
      openExecutionLocation(root, { create: true }),
      openExecutionLocation(root, { create: true }),
    ]);
    expect(first).toEqual(second);
    expect(await openExecutionLocation(root)).toEqual(first);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, 'location.json'))).mode & 0o777).toBe(0o600);
  });
  it('never creates a missing location during a read', async () => {
    await expect(openExecutionLocation(root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses to replace a missing marker in an existing root', async () => {
    await openExecutionLocation(root, { create: true });
    await rm(join(root, 'location.json'));
    await expect(openExecutionLocation(root, { create: true })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(root, 'location.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves a malformed marker instead of silently generating another identity', async () => {
    await openExecutionLocation(root, { create: true });
    await writeFile(join(root, 'location.json'), 'broken');
    await expect(openExecutionLocation(root, { create: true })).rejects.toThrow();
    expect(await readFile(join(root, 'location.json'), 'utf8')).toBe('broken');
  });
  it('rejects a copied marker after directory replacement', async () => {
    await openExecutionLocation(root, { create: true });
    const old = join(parent, 'old');
    await rename(root, old);
    await mkdir(root, { mode: 0o700 });
    await copyFile(join(old, 'location.json'), join(root, 'location.json'));
    await expect(openExecutionLocation(root)).rejects.toThrow('Storage root changed');
  });
  it.each(['root', 'marker'])('rejects a symbolic link %s', async (target) => {
    await openExecutionLocation(root, { create: true });
    const old = join(parent, 'old');
    if (target === 'root') {
      await rename(root, old);
      await symlink(old, root);
    } else {
      await rename(join(root, 'location.json'), old);
      await symlink(old, join(root, 'location.json'));
    }
    await expect(openExecutionLocation(root)).rejects.toThrow();
  });
  it.each(['root', 'marker'])('rejects permissive %s permissions', async (target) => {
    await openExecutionLocation(root, { create: true });
    await chmod(target === 'root' ? root : join(root, 'location.json'), target === 'root' ? 0o755 : 0o644);
    await expect(openExecutionLocation(root)).rejects.toThrow('private');
  });
  it('reports failed marker closure after successful validation', async () => {
    await openExecutionLocation(root, { create: true });
    boundary.failClose = true;
    await expect(openExecutionLocation(root)).rejects.toBeInstanceOf(StorageReadCleanupError);
  });
  it('preserves malformed marker failure alongside failed closure', async () => {
    await openExecutionLocation(root, { create: true });
    await writeFile(join(root, 'location.json'), 'broken');
    boundary.failClose = true;
    await expect(openExecutionLocation(root)).rejects.toMatchObject({
      errors: [expect.any(SyntaxError), expect.any(StorageReadCleanupError)],
    });
  });
});
