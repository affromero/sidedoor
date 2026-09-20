import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageCleanup } from '../../../src/storage/cleanup/backends/local-cleanup';

const faults = vi.hoisted(() => ({
  flush: false,
  unlinkStarted: null as (() => void) | null,
  unlinkGate: null as Promise<void> | null,
  beforeStat: null as ((path: unknown) => Promise<void>) | null,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      await faults.beforeStat?.(args[0]);
      return fs.lstat(...args);
    },
    unlink: async (path: Parameters<typeof fs.unlink>[0]) => {
      if (faults.unlinkGate) {
        faults.unlinkStarted?.();
        await faults.unlinkGate;
      }
      return fs.unlink(path);
    },
  };
});
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    fsyncSync: (descriptor: number) => {
      if (faults.flush) throw new Error('Filesystem flush unavailable');
      fs.fsyncSync(descriptor);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  faults.flush = false;
  faults.unlinkStarted = null;
  faults.unlinkGate = null;
  faults.beforeStat = null;
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-cleanup-'));
  directories.push(directory);
  const root = join(directory, 'storage');
  await mkdir(root);
  return { directory, root, cleanup: await LocalStorageCleanup.capture(root) };
}

describe('local cleanup bound to an existing directory', () => {
  it.each(['file', 'prefix'] as const)(
    'does not report an absent %s when the root changes during the lookup',
    async (kind) => {
      const { root, cleanup } = await fixture();
      faults.beforeStat = async (path) => {
        if (typeof path !== 'string' || !path.endsWith('/missing')) return;
        faults.beforeStat = null;
        await rename(root, `${root}-old`);
        await mkdir(root);
      };
      await expect(
        kind === 'file' ? cleanup.has('missing') : cleanup.list('missing/').next(),
      ).rejects.toThrow('root changed');
    },
  );
  it('verifies a root file while rejecting symlinks and ignoring neighbouring names', async () => {
    const { root, cleanup } = await fixture();
    await writeFile(join(root, 'avatar.png'), 'private');
    await writeFile(join(root, 'avatar.png.backup'), 'keep');
    expect(await cleanup.has('avatar.png')).toBe(true);
    await cleanup.delete('avatar.png');
    expect(await cleanup.has('avatar.png')).toBe(false);
    expect(await cleanup.has('avatar.png.backup')).toBe(true);
    await symlink(join(root, 'avatar.png.backup'), join(root, 'avatar.png'));
    await expect(cleanup.has('avatar.png')).rejects.toThrow('not a regular file');
    await cleanup.delete('avatar.png.backup');
    expect(await cleanup.has('avatar.png.backup')).toBe(false);
  });
  it('keeps missing-file verification unresolved when the directory cannot be flushed or its root was replaced', async () => {
    const { root, cleanup } = await fixture();
    faults.flush = true;
    await expect(cleanup.has('missing.wav')).rejects.toThrow('Filesystem flush unavailable');
    await expect(cleanup.list('missing/').next()).rejects.toThrow('Filesystem flush unavailable');
    faults.flush = false;
    expect(await cleanup.has('missing.wav')).toBe(false);
    expect(await cleanup.list('missing/').next()).toEqual({ done: true, value: undefined });
    await rename(root, `${root}-old`);
    await mkdir(root);
    await expect(cleanup.has('missing.wav')).rejects.toThrow('root changed');
  });
  it('keeps discovery and deletion separate in both start orders', async () => {
    const { root, cleanup } = await fixture();
    await mkdir(join(root, 'owned'));
    await writeFile(join(root, 'owned', 'file'), 'private');
    const listing = cleanup.list('owned/');
    await listing.next();
    await expect(cleanup.delete('owned/file')).rejects.toThrow('Finish collecting');
    await listing.return(undefined);
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      faults.unlinkStarted = resolve;
    });
    faults.unlinkGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = cleanup.delete('owned/file');
    await started;
    try {
      await expect(cleanup.list('owned/').next()).rejects.toThrow('Finish deleting');
      await expect(cleanup.has('owned/file')).rejects.toThrow('Finish deleting');
    } finally {
      release();
    }
    await operation;
    expect(await cleanup.list('owned/').next()).toEqual({ done: true, value: undefined });
  });
  it('streams only the owned prefix and refuses linked directories', async () => {
    const { root, cleanup } = await fixture();
    await mkdir(join(root, 'episodes', 'owned', 'segments'), { recursive: true });
    await mkdir(join(root, 'episodes', 'other'));
    await writeFile(join(root, 'episodes', 'owned', 'audio.mp3'), 'audio');
    await writeFile(join(root, 'episodes', 'owned', 'segments', 'one.mp3'), 'segment');
    await writeFile(join(root, 'episodes', 'other', 'audio.mp3'), 'other');
    const keys: string[] = [];
    for await (const key of cleanup.list('episodes/owned/')) keys.push(key);
    expect(keys.sort()).toEqual(['episodes/owned/audio.mp3', 'episodes/owned/segments/one.mp3']);
    await symlink(join(root, 'episodes', 'other'), join(root, 'episodes', 'owned', 'linked'));
    await expect(
      (async () => {
        for await (const key of cleanup.list('episodes/owned/')) void key;
      })(),
    ).rejects.toThrow('symbolic links');
    expect(await readFile(join(root, 'episodes', 'other', 'audio.mp3'), 'utf8')).toBe('other');
  });
  it('keeps deletion unresolved until directory changes are durable, including absent-file retries', async () => {
    const { root, cleanup } = await fixture();
    await writeFile(join(root, 'remove'), 'remove');
    faults.flush = true;
    await expect(cleanup.delete('remove')).rejects.toThrow('Filesystem flush unavailable');
    await expect(readFile(join(root, 'remove'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(cleanup.delete('remove')).rejects.toThrow('Filesystem flush unavailable');
    faults.flush = false;
    await cleanup.delete('remove');
  });
  it('deletes exact files idempotently and preserves neighbouring files', async () => {
    const { root, cleanup } = await fixture();
    await mkdir(join(root, 'recordings'));
    await writeFile(join(root, 'recordings', 'été 100%.wav'), 'remove');
    await writeFile(join(root, 'recordings', 'keep.wav'), 'keep');
    const restored = await LocalStorageCleanup.restore(structuredClone(cleanup.identity));
    await restored.delete('recordings/été 100%.wav');
    await restored.delete('recordings/été 100%.wav');
    await expect(readFile(join(root, 'recordings', 'été 100%.wav'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(root, 'recordings', 'keep.wav'), 'utf8')).toBe('keep');
    await expect(restored.delete('recordings')).rejects.toThrow('regular file');
    await expect(restored.delete('../outside')).rejects.toThrow();
  });

  it('rejects linked parents and linked files without touching their targets', async () => {
    const { directory, root, cleanup } = await fixture();
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep'), 'keep');
    await symlink(outside, join(root, 'parent'));
    await symlink(join(outside, 'keep'), join(root, 'file'));
    await expect(cleanup.delete('parent/keep')).rejects.toThrow('symbolic links');
    await expect(cleanup.delete('file')).rejects.toThrow('symbolic links');
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('keep');
  });

  it('rejects replacement roots both in an existing executor and after restart', async () => {
    const { root, cleanup } = await fixture();
    await rename(root, `${root}-original`);
    await mkdir(root);
    await writeFile(join(root, 'keep'), 'replacement');
    await expect(cleanup.delete('keep')).rejects.toThrow('root changed');
    await expect(LocalStorageCleanup.restore(cleanup.identity)).rejects.toThrow('root changed');
    expect(await readFile(join(root, 'keep'), 'utf8')).toBe('replacement');
  });

  it('captures the real root so retargeting a configuration alias cannot redirect cleanup', async () => {
    const { directory, root } = await fixture();
    const alias = join(directory, 'alias');
    await symlink(root, alias);
    const cleanup = await LocalStorageCleanup.capture(alias);
    await writeFile(join(root, 'remove'), 'original');
    await rm(alias);
    const replacement = join(directory, 'replacement');
    await mkdir(replacement);
    await writeFile(join(replacement, 'remove'), 'keep');
    await symlink(replacement, alias);
    await cleanup.delete('remove');
    expect(await readFile(join(replacement, 'remove'), 'utf8')).toBe('keep');
  });
});
