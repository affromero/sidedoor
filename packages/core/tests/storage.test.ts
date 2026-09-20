import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FileStateStore,
  acquireFileLock,
  acquireFileLockSync,
  withFileLock,
  withSharedFileLockSync,
  FileLockBusyError,
} from '../src/storage/index';

const schema = z.object({ remaining: z.number().int().nonnegative() });
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-state-'));
  directories.push(directory);
  const path = join(directory, 'state.json');
  const create = () =>
    new FileStateStore({ path, initial: () => ({ remaining: 1 }), parse: (value) => schema.parse(value) });
  return { path, create };
}

describe('durable state', () => {
  it('releases synchronous leases once without closing a later lock', async () => {
    const { path } = await fixture();
    const first = acquireFileLockSync(path);
    expect(() => acquireFileLockSync(path)).toThrow(FileLockBusyError);
    first();
    const second = acquireFileLockSync(path);
    try {
      first();
      expect(() => acquireFileLockSync(path)).toThrow(FileLockBusyError);
      const unrelated = acquireFileLockSync(`${path}.other`);
      unrelated();
    } finally {
      second();
    }
    expect(withSharedFileLockSync(path, () => 'released')).toBe('released');
  });

  it('rejects a synchronous write during cleanup without running its mutation', async () => {
    const { path } = await fixture();
    const release = await acquireFileLock(path);
    let value = 'original';
    try {
      expect(() =>
        withSharedFileLockSync(path, () => {
          value = 'changed';
        }),
      ).toThrow(FileLockBusyError);
      expect(value).toBe('original');
    } finally {
      await release();
    }
    withSharedFileLockSync(path, () => {
      value = 'changed';
    });
    expect(value).toBe('changed');
  });

  it('allows synchronous commits alongside shared activity and releases after errors', async () => {
    const { path } = await fixture();
    const release = await acquireFileLock(path, { mode: 'shared' });
    try {
      expect(withSharedFileLockSync(path, () => 'committed')).toBe('committed');
      expect(() =>
        withSharedFileLockSync(path, () => {
          throw new Error('mutation failed');
        }),
      ).toThrow('mutation failed');
    } finally {
      await release();
    }
    expect(await withFileLock(path, () => 'cleanup')).toBe('cleanup');
  });

  it('permits concurrent shared activity while excluding cleanup until all activity releases', async () => {
    const { path } = await fixture();
    const anchor = `${path}.activity`;
    const first = await acquireFileLock(anchor, { mode: 'shared' });
    const second = await acquireFileLock(anchor, { mode: 'shared' });
    try {
      await expect(withFileLock(anchor, () => 'cleanup', { timeoutMs: 30 })).rejects.toThrow(
        FileLockBusyError,
      );
    } finally {
      await first();
      await second();
    }
    expect(await withFileLock(anchor, () => 'cleanup')).toBe('cleanup');
  });

  it('releases a cancelled waiter without disturbing the active lock', async () => {
    const { path } = await fixture();
    const anchor = `${path}.activity`;
    const release = await acquireFileLock(anchor);
    const controller = new AbortController();
    const waiting = acquireFileLock(anchor, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await release();
    expect(await withFileLock(anchor, () => 'available')).toBe('available');
  });
  it('does not commit when a transaction returns an unserializable result', async () => {
    const { create } = await fixture();
    await expect(
      create().transact((state) => {
        state.remaining = 0;
        return () => 'unsupported';
      }),
    ).rejects.toThrow();
    expect(await create().read()).toEqual({ remaining: 1 });
  });
  it('allows only one concurrent redemption across independent stores', async () => {
    const { create } = await fixture();
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        create().transact((state) => {
          if (!state.remaining) return false;
          state.remaining--;
          return true;
        }),
      ),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await create().read()).toEqual({ remaining: 0 });
  });

  it('leaves committed state intact when a transaction fails', async () => {
    const { create } = await fixture();
    await create().transact((state) => {
      state.remaining = 3;
    });
    await expect(
      create().transact((state) => {
        state.remaining = 0;
        throw new Error('rejected');
      }),
    ).rejects.toThrow('rejected');
    expect(await create().read()).toEqual({ remaining: 3 });
  });

  it('refuses corrupted storage rather than restoring an empty initial state', async () => {
    const { path, create } = await fixture();
    await writeFile(path, '{broken');
    await expect(
      create().transact((state) => {
        state.remaining = 0;
      }),
    ).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });
});
