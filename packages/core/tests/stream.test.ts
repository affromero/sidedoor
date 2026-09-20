import { expect, it } from 'vitest';
import { guardStream, interruptibleStream, type StreamGuard } from '../src/runtime/stream';
import { mkdtempSync, writeFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.each(['direct', 'aggregate', 'cause', 'cyclic-cause'])(
  'preserves outer filesystem cleanup failures during pending reads (%s)',
  async (wrapper) => {
    const directory = mkdtempSync(join(tmpdir(), 'stream-cleanup-'));
    writeFileSync(join(directory, 'retained'), 'owned artifact');
    const cleanup = () => {
      try {
        rmdirSync(directory);
      } catch (error) {
        if (wrapper === 'aggregate')
          throw new AggregateError([error], 'Resource cleanup failed', { cause: error });
        if (wrapper === 'cause') throw new Error('Generation cleanup failed', { cause: error });
        if (wrapper === 'cyclic-cause') {
          const cyclic = new Error('Cyclic cause');
          cyclic.cause = cyclic;
          throw new AggregateError(
            [cyclic, new Error('Generation cleanup failed', { cause: error })],
            'Cleanup failed',
            { cause: error },
          );
        }
        throw error;
      }
    };
    const stream = interruptibleStream(
      async function* (signal) {
        try {
          yield 'ready';
          await new Promise<void>((...callbacks) => {
            signal.addEventListener('abort', () => callbacks[1](signal.reason), { once: true });
          });
        } finally {
          cleanup();
        }
      },
      { isCleanupError: (error) => error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY' },
    );
    try {
      expect(await stream.next()).toMatchObject({ value: 'ready' });
      const pending = stream.next().catch((error: unknown) => error);
      const closing = stream.return(undefined).catch((error: unknown) => error);
      const failure = await pending;
      expect(failure).toBeInstanceOf(Error);
      expect(await closing).toBe(failure);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('does not open resources when closed before its first read', async () => {
  const stream = interruptibleStream(
    () => {
      throw new Error('Unexpected resource acquisition');
    },
    { isCleanupError: () => false },
  );
  expect(await stream.return(undefined)).toMatchObject({ done: true });
});

it('rejects asynchronous validators supplied by untyped callers without leaking bytes', async () => {
  let released = false;
  const guard: StreamGuard = {
    validate() {},
    release() {
      released = true;
    },
  };
  Object.defineProperty(guard, 'validate', {
    value: async () => {
      throw new Error('Denied');
    },
  });
  const source = new ReadableStream<string>({
    start(controller) {
      controller.enqueue('private');
    },
  });
  await expect(guardStream(source, guard).getReader().read()).rejects.toThrow('must be synchronous');
  expect(released).toBe(true);
  expect(source.locked).toBe(false);
});

it('rejects bytes when authorization changes while a read is pending', async () => {
  let upstream!: ReadableStreamDefaultController<string>;
  let authorized = true;
  let released = false;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const source = new ReadableStream<string>(
    {
      start(controller) {
        upstream = controller;
      },
      pull() {
        entered();
      },
    },
    { highWaterMark: 0 },
  );
  const stream = guardStream(source, {
    validate() {
      if (!authorized) throw new Error('Revoked');
    },
    release() {
      released = true;
    },
  });
  const read = stream.getReader().read();
  await started;
  authorized = false;
  upstream.enqueue('private bytes');
  await expect(read).rejects.toThrow('Revoked');
  expect(released).toBe(true);
  expect(source.locked).toBe(false);
});

it('cancels a pending upstream read and releases its resources', async () => {
  let upstreamCancelled = false;
  let released = false;
  const source = new ReadableStream<string>({
    cancel() {
      upstreamCancelled = true;
    },
  });
  const reader = guardStream(source, {
    validate() {},
    release() {
      released = true;
    },
  }).getReader();
  const reading = reader.read();
  await reader.cancel();
  expect(await reading).toEqual({ done: true, value: undefined });
  expect(upstreamCancelled).toBe(true);
  expect(released).toBe(true);
  expect(source.locked).toBe(false);
});

it('delivers authorized bytes unchanged and releases on completion', async () => {
  let released = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
  const response = new Response(
    guardStream(source, {
      validate() {},
      release() {
        released = true;
      },
    }),
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  expect(released).toBe(true);
});
