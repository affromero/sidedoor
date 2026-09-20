import { Readable } from 'node:stream';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyOwnedReadableToFile, withOwnedReadables } from '../../../src/storage/local/owned-readable';
import { StorageReadCleanupError } from '../../../src/storage/local/owned-copy';

describe('owned transport stream copying', () => {
  it('waits for delayed source closure after successful work', async () => {
    let release!: () => void;
    let closing!: () => void;
    const started = new Promise<void>((resolve) => {
      closing = resolve;
    });
    const source = new Readable({
      read() {},
      destroy(error, callback) {
        release = () => callback(error);
        closing();
      },
    });
    let returned = false;
    const work = withOwnedReadables([source], async () => 'published').then((value) => {
      returned = true;
      return value;
    });
    await started;
    expect(returned).toBe(false);
    release();
    expect(await work).toBe('published');
    expect(source.closed).toBe(true);
  });
  it('closes other sources promptly when one source hangs and preserves observed failures', async () => {
    let release!: () => void;
    const hung = new Readable({
      read() {},
      destroy(error, callback) {
        release = () => callback(error);
      },
    });
    const failure = new Error('Second source failed to close');
    const failed = new Readable({
      read() {},
      destroy(error, callback) {
        callback(failure);
      },
    });
    const primary = new Error('Upload failed');
    const work = withOwnedReadables([hung, failed], async () => {
      throw primary;
    });
    const observed = work.catch((error) => error as unknown);
    await expect.poll(() => failed.closed).toBe(true);
    const error = await observed;
    expect(error).toMatchObject({
      errors: [
        primary,
        {
          name: 'StorageReadCleanupError',
          cause: {
            errors: [
              expect.objectContaining({ errors: [failure] }),
              expect.objectContaining({ message: 'Storage stream cleanup timed out' }),
            ],
          },
        },
      ],
    });
    release();
    await expect.poll(() => hung.closed).toBe(true);
  });
  it('accepts already closed sources without rereading them', async () => {
    const source = Readable.from([]);
    const closed = once(source, 'close');
    source.destroy();
    await closed;
    expect(await withOwnedReadables([source], async () => 42)).toBe(42);
  });
  let root: string;
  let destination: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidedoor-stream-'));
    destination = join(root, 'audio');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it('preserves binary chunks and confirms stream closure after EOF', async () => {
    const source = Readable.from([Buffer.from([0, 255]), Buffer.from([128, 10])]);
    await copyOwnedReadableToFile({ destination, openSource: async () => source });
    expect(await readFile(destination)).toEqual(Buffer.from([0, 255, 128, 10]));
    expect(source.closed).toBe(true);
  });
  it('preserves a truncated read and its ambiguous automatic destruction', async () => {
    const reason = new Error('Network truncated');
    const source = new Readable({
      read() {
        this.destroy(reason);
      },
    });
    await expect(
      copyOwnedReadableToFile({ destination, openSource: async () => source }),
    ).rejects.toMatchObject({ errors: [reason, expect.any(StorageReadCleanupError)] });
    expect(source.closed).toBe(true);
  });
  it('reports failed explicit destruction after all bytes have been copied', async () => {
    const failure = new Error('Destroy acknowledgement failed');
    const source = new Readable({
      autoDestroy: false,
      read() {
        this.push(Buffer.from('complete'));
        this.push(null);
      },
      destroy(...[, callback]) {
        callback(failure);
      },
    });
    await expect(
      copyOwnedReadableToFile({ destination, openSource: async () => source }),
    ).rejects.toMatchObject({
      name: 'StorageReadCleanupError',
      cause: { errors: [expect.objectContaining({ errors: [failure] })] },
    });
    expect(await readFile(destination, 'utf8')).toBe('complete');
  });
  it('handles a stream whose clean EOF and closure occurred before acquisition', async () => {
    const source = Readable.from([]);
    const closed = once(source, 'close');
    source.resume();
    await closed;
    await copyOwnedReadableToFile({ destination, openSource: async () => source });
    expect(await readFile(destination)).toHaveLength(0);
    expect(source.closed).toBe(true);
  });
  it('cancels a pending read only after observable source closure', async () => {
    const controller = new AbortController();
    const reason = new Error('Stop reading');
    const source = new Readable({
      read() {
        controller.abort(reason);
      },
    });
    await expect(
      copyOwnedReadableToFile({ destination, signal: controller.signal, openSource: async () => source }),
    ).rejects.toBe(reason);
    expect(source.closed).toBe(true);
  });
  it('reports uncertainty when destruction does not acknowledge closure', async () => {
    const controller = new AbortController();
    const reason = new Error('Stop uncooperative source');
    let finish: (() => void) | undefined;
    const source = new Readable({
      read() {
        controller.abort(reason);
      },
      destroy(...[, callback]) {
        finish = () => callback();
      },
    });
    await expect(
      copyOwnedReadableToFile({ destination, signal: controller.signal, openSource: async () => source }),
    ).rejects.toMatchObject({ errors: [reason, expect.any(StorageReadCleanupError)] });
    expect(source.closed).toBe(false);
    finish!();
    await expect.poll(() => source.closed).toBe(true);
  });
  it('closes a body acquired after cancellation without creating a destination', async () => {
    const controller = new AbortController();
    const reason = new Error('Stop acquisition');
    let acquire: ((source: Readable) => void) | undefined;
    const running = copyOwnedReadableToFile({
      destination,
      signal: controller.signal,
      openSource: () =>
        new Promise<Readable>((resolve) => {
          acquire = resolve;
          controller.abort(reason);
        }),
    });
    await expect(running).rejects.toMatchObject({ errors: [reason, expect.any(StorageReadCleanupError)] });
    const source = Readable.from([Buffer.from('late')]);
    acquire!(source);
    await expect.poll(() => source.closed).toBe(true);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('observes errors queued by an already destroyed late body', async () => {
    const controller = new AbortController();
    let acquire: ((source: Readable) => void) | undefined;
    const running = copyOwnedReadableToFile({
      destination,
      signal: controller.signal,
      openSource: () =>
        new Promise<Readable>((resolve) => {
          acquire = resolve;
          controller.abort();
        }),
    });
    await expect(running).rejects.toMatchObject({
      errors: [expect.any(Error), expect.any(StorageReadCleanupError)],
    });
    const source = new Readable({ read() {} });
    source.destroy(new Error('Late body failed'));
    acquire!(source);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(source.closed).toBe(true);
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a stream without an observable close event', async () => {
    const source = new Readable({
      emitClose: false,
      read() {
        this.push(null);
      },
    });
    await expect(
      copyOwnedReadableToFile({ destination, openSource: async () => source }),
    ).rejects.toBeInstanceOf(StorageReadCleanupError);
    expect(source.closed).toBe(true);
  });
  it('retains uncertainty after a real HTTP response is truncated', async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'Content-Length': '100' });
      response.flushHeaders();
      response.write(Buffer.from('partial'));
      setTimeout(() => response.destroy(), 20);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    try {
      await expect(
        copyOwnedReadableToFile({
          destination,
          openSource: () =>
            new Promise<Readable>((resolve, reject) => {
              get(`http://127.0.0.1:${address.port}/audio`, resolve).on('error', reject);
            }),
        }),
      ).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(StorageReadCleanupError)] });
      expect(await readFile(destination, 'utf8')).toBe('partial');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('bounds diagnostic retention when a malformed stream emits repeated errors', async () => {
    const source = new Readable({
      read() {
        for (let index = 0; index < 100; index++) this.emit('error', new Error(`Stream fault ${index}`));
      },
    });
    const failure = await copyOwnedReadableToFile({ destination, openSource: async () => source }).catch(
      (error) => error as unknown,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    const cleanup = (failure as AggregateError).errors[1] as StorageReadCleanupError;
    const resources = cleanup.cause as AggregateError;
    const closure = resources.errors[0] as AggregateError;
    expect(closure.errors).toHaveLength(8);
    expect(Number(closure.message.match(/\d+/)?.[0])).toBeGreaterThanOrEqual(100);
    expect(source.closed).toBe(true);
  });
});
