import { describe, expect, it } from 'vitest';
import { readResponseText, readResponseBytes, ResponseBodyTooLargeError } from '../src/runtime/stream';

describe('bounded response reading', () => {
  it('detaches reused Node Buffer chunks before the next read mutates them', async () => {
    const buffer = Buffer.alloc(1);
    let read = 0;
    const response = new Response(
      new ReadableStream(
        {
          pull(controller) {
            if (++read > 2) {
              controller.close();
              return;
            }
            buffer[0] = read;
            controller.enqueue(buffer);
          },
        },
        { highWaterMark: 0 },
      ),
    );
    expect(await readResponseBytes(response, { signal: new AbortController().signal, maxBytes: 2 })).toEqual(
      new Uint8Array([1, 2]),
    );
  });
  it('preserves binary response bytes across chunks through EOF', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 255, 128]));
          controller.enqueue(new Uint8Array([1, 2]));
          controller.close();
        },
      }),
    );
    expect(await readResponseBytes(response, { signal: new AbortController().signal, maxBytes: 5 })).toEqual(
      new Uint8Array([0, 255, 128, 1, 2]),
    );
    expect(response.body?.locked).toBe(false);
  });
  it.each(['cancelled', 'cleanup-failed', 'oversized'] as const)(
    'owns binary response cleanup when %s',
    async (mode) => {
      const controller = new AbortController();
      const primary = new Error('Cancelled binary read');
      const cleanup = new Error('Body cleanup failed');
      let cancelled = false;
      const response = new Response(
        new ReadableStream({
          start(stream) {
            if (mode === 'oversized') stream.enqueue(new Uint8Array(6));
          },
          cancel() {
            cancelled = true;
            if (mode === 'cleanup-failed') throw cleanup;
          },
        }),
      );
      const running = readResponseBytes(response, { signal: controller.signal, maxBytes: 5 });
      if (mode !== 'oversized') controller.abort(primary);
      if (mode === 'oversized') await expect(running).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
      else if (mode === 'cleanup-failed')
        await expect(running).rejects.toMatchObject({ errors: [primary, cleanup] });
      else await expect(running).rejects.toBe(primary);
      expect(cancelled).toBe(true);
      expect(response.body?.locked).toBe(false);
    },
  );
  it('decodes split UTF-8 and flushes incomplete characters at EOF', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0xe2]));
          controller.enqueue(new Uint8Array([0x82, 0xac, 0xe2]));
          controller.close();
        },
      }),
    );
    expect(await readResponseText(response, { signal: new AbortController().signal, maxBytes: 4 })).toBe(
      '€�',
    );
    expect(response.body?.locked).toBe(false);
  });

  it('counts actual bytes even when Content-Length claims less', async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { 'content-length': '1' } },
    );
    await expect(
      readResponseText(response, { signal: new AbortController().signal, maxBytes: 4 }),
    ).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(canceled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it.each([false, true])('interrupts stalled reads and bounds cleanup when hanging=%s', async (hanging) => {
    const controller = new AbortController();
    const failure = new Error('Caller canceled after headers');
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
          return hanging ? new Promise<void>(() => {}) : undefined;
        },
      }),
    );
    const pending = readResponseText(response, { signal: controller.signal, maxBytes: 10 });
    controller.abort(failure);
    if (hanging) await expect(pending).rejects.toMatchObject({ cause: failure });
    else await expect(pending).rejects.toBe(failure);
    expect(canceled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it('rejects cancellation before locking a body and accepts an absent body', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Canceled'));
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    );
    await expect(readResponseText(response, { signal: controller.signal, maxBytes: 10 })).rejects.toThrow(
      'Canceled',
    );
    expect(response.body?.locked).toBe(false);
    expect(canceled).toBe(true);
    expect(
      await readResponseText(new Response(null), { signal: new AbortController().signal, maxBytes: 0 }),
    ).toBe('');
  });
});
