import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageCleanup } from '../../../src/storage/cleanup/backends/local-cleanup';
import { LocalStorageWriter } from '../../../src/storage/local/local-writer';

describe('immutable local storage writes', () => {
  let directory: string;
  let root: string;
  let writer: LocalStorageWriter;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'sidedoor-writer-'));
    root = join(directory, 'storage');
    await mkdir(root);
    writer = await LocalStorageWriter.restore((await LocalStorageCleanup.capture(root)).identity);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes buffers and streams into private nested files without overwriting existing content', async () => {
    await writer.writeImmutable('profile/artifacts/one.bin', Buffer.from('original'));
    await writer.writeImmutable('profile/artifacts/two.bin', Readable.from(['stream', ' content']));
    expect(await readFile(join(root, 'profile/artifacts/one.bin'), 'utf8')).toBe('original');
    expect(await readFile(join(root, 'profile/artifacts/two.bin'), 'utf8')).toBe('stream content');
    expect((await stat(join(root, 'profile/artifacts/one.bin'))).mode & 0o777).toBe(0o600);
    await expect(
      writer.writeImmutable('profile/artifacts/one.bin', Buffer.from('replacement')),
    ).rejects.toMatchObject({ created: false, cause: { code: 'EEXIST' } });
    expect(await readFile(join(root, 'profile/artifacts/one.bin'), 'utf8')).toBe('original');
  });

  it('refuses a replaced captured root before creating a file', async () => {
    await rename(root, join(directory, 'previous'));
    await mkdir(root);
    await expect(writer.writeImmutable('one.bin', Buffer.from('content'))).rejects.toMatchObject({
      created: false,
    });
    await expect(stat(join(root, 'one.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows only one concurrent writer to create a destination', async () => {
    const results = await Promise.allSettled([
      writer.writeImmutable('shared/output.bin', Buffer.from('first')),
      writer.writeImmutable('shared/output.bin', Buffer.from('second')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { created: false, cause: { code: 'EEXIST' } },
    });
    expect(['first', 'second']).toContain(await readFile(join(root, 'shared/output.bin'), 'utf8'));
  });

  it('rejects traversal and symlink parents without writing outside the captured root', async () => {
    await symlink(directory, join(root, 'link'));
    for (const key of ['../escaped.bin', 'link/escaped.bin', '/escaped.bin']) {
      await expect(writer.writeImmutable(key, Buffer.from('content'))).rejects.toMatchObject({
        created: false,
      });
    }
    await expect(stat(join(directory, 'escaped.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains failed stream files for the admitted operation cleanup', async () => {
    const source = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('Input stream failed');
      })(),
    );
    await expect(writer.writeImmutable('partial.bin', source)).rejects.toMatchObject({
      created: true,
      cause: { message: 'Input stream failed' },
    });
    expect((await stat(join(root, 'partial.bin'))).isFile()).toBe(true);
    const cleanup = await LocalStorageCleanup.capture(root);
    await cleanup.delete('partial.bin');
    expect(await cleanup.has('partial.bin')).toBe(false);
  });

  it('cancels a stalled stream and retains the created target until explicit cleanup', async () => {
    const abort = new AbortController();
    const source = new Readable({
      read() {
        abort.abort();
      },
    });
    await expect(writer.writeImmutable('cancelled.bin', source, abort.signal)).rejects.toMatchObject({
      created: true,
      cause: { name: 'AbortError' },
    });
    expect(source.destroyed).toBe(true);
    expect((await stat(join(root, 'cancelled.bin'))).isFile()).toBe(true);
    await expect(
      writer.writeImmutable('never-created.bin', Buffer.from('content'), abort.signal),
    ).rejects.toMatchObject({ created: false });
    await expect(stat(join(root, 'never-created.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
