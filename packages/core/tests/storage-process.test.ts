import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLockBusyError, FileStateStore, withFileLock, withSharedFileLockSync } from '../src/storage';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }),
  );
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('filesystem process coordination', () => {
  it('permits shared work in another process and releases a crashed activity before cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidedoor-activity-process-'));
    directories.push(directory);
    const path = join(directory, 'profile.guard');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { openSync } from 'node:fs';
      import { createRequire } from 'node:module';
      const fileLocks = createRequire(import.meta.url)('thesidedoor-flock');
      const fd = openSync(process.argv[1], 'a', 0o600);
      fileLocks.flock(fd, fileLocks.constants.LOCK_SH);
      process.send('locked');
      setInterval(() => {}, 1000);
    `,
        path,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    children.push(child);
    const ready = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Activity exited before acquiring lock');
      }),
    ]);
    expect(ready[0]).toBe('locked');
    expect(withSharedFileLockSync(path, () => 'read completed')).toBe('read completed');
    await expect(withFileLock(path, () => 'cleanup', { timeoutMs: 30 })).rejects.toThrow(FileLockBusyError);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    expect(await withFileLock(path, () => 'cleanup')).toBe('cleanup');
  });

  it('retains exclusion while the lock owner is suspended and releases it after a crash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidedoor-process-'));
    directories.push(directory);
    const path = join(directory, 'state.json');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { openSync } from 'node:fs';
      import { createRequire } from 'node:module';
      const fileLocks = createRequire(import.meta.url)('thesidedoor-flock');
      const fd = openSync(process.argv[1] + '.guard', 'a', 0o600);
      fileLocks.flock(fd, fileLocks.constants.LOCK_EX);
      process.send('locked');
      setInterval(() => {}, 1000);
    `,
        path,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    children.push(child);
    const ready = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Lock owner exited before acquiring lock');
      }),
    ]);
    expect(ready[0]).toBe('locked');
    child.kill('SIGSTOP');
    const store = new FileStateStore({
      path,
      initial: () => ({ redeemed: false }),
      parse: (value) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('redeemed' in value) ||
          typeof value.redeemed !== 'boolean'
        )
          throw new Error('Invalid state');
        return { redeemed: value.redeemed };
      },
    });
    let committed = false;
    const pending = store
      .transact((state) => {
        state.redeemed = true;
      })
      .then(() => {
        committed = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(committed).toBe(false);
    expect(await store.read()).toEqual({ redeemed: false });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await pending;
    expect(await store.read()).toEqual({ redeemed: true });
  });
});
