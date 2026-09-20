import { describe, expect, it } from 'vitest';
import { createMediaTransport } from '../src/providers/transport';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('credential-free media downloads', () => {
  it('admits relative and cross-origin redirects and preserves signed queries without credentials', async () => {
    const admitted: string[] = [];
    const sent: string[] = [];
    const transport = createMediaTransport({
      maxBytes: 32,
      timeoutMs: 1_000,
      admit: async (request) => {
        admitted.push(request.url);
      },
      implementation: async (input, init) => {
        const request = new Request(input, init);
        expect(request.method).toBe('GET');
        expect([...request.headers]).toEqual([]);
        expect(request.credentials).toBe('omit');
        expect(request.redirect).toBe('manual');
        sent.push(request.url);
        if (sent.length === 1)
          return new Response(null, { status: 302, headers: { location: '/next?signature=a%2Fb' } });
        if (sent.length === 2)
          return new Response(null, {
            status: 307,
            headers: { location: 'https://cdn.example/audio?signature=x%2By' },
          });
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    expect(await transport.downloadMedia('https://media.example/start')).toEqual(new Uint8Array([1, 2, 3]));
    expect(sent).toEqual([
      'https://media.example/start',
      'https://media.example/next?signature=a%2Fb',
      'https://cdn.example/audio?signature=x%2By',
    ]);
    expect(admitted).toEqual(sent);
  });

  it('stops before the next redirect request when authority is revoked', async () => {
    let revoked = false;
    let cancelled = false;
    const sent: string[] = [];
    const transport = createMediaTransport({
      maxBytes: 32,
      timeoutMs: 1_000,
      admit: async () => {
        if (revoked) throw new Error('Revoked');
      },
      implementation: async (input) => {
        sent.push(new Request(input).url);
        revoked = true;
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 302, headers: { location: '/next' } },
        );
      },
    });
    await expect(transport.downloadMedia('https://media.example/start')).rejects.toThrow('Revoked');
    expect(sent).toEqual(['https://media.example/start']);
    expect(cancelled).toBe(true);
  });

  it.each([undefined, '1'])(
    'bounds actual streamed bytes despite content-length %s',
    async (contentLength) => {
      let cancelled = false;
      const transport = createMediaTransport({
        maxBytes: 3,
        timeoutMs: 1_000,
        admit: async () => {},
        implementation: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
                controller.enqueue(new Uint8Array([3, 4]));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: contentLength ? { 'content-length': contentLength } : {} },
          ),
      });
      await expect(transport.downloadMedia('https://media.example/audio')).rejects.toThrow(
        'Media byte limit exceeded',
      );
      expect(cancelled).toBe(true);
    },
  );

  it('cancels a stalled body at the caller-selected deadline', async () => {
    let cancelled = false;
    const transport = createMediaTransport({
      maxBytes: 32,
      timeoutMs: 20,
      admit: async () => {},
      implementation: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    await expect(transport.downloadMedia('https://media.example/audio')).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(cancelled).toBe(true);
  });

  it('bounds redirect loops and rejects embedded credentials before dispatch', async () => {
    const sent: string[] = [];
    const transport = createMediaTransport({
      maxBytes: 32,
      timeoutMs: 1_000,
      maxRedirects: 1,
      admit: async () => {},
      implementation: async (input) => {
        sent.push(new Request(input).url);
        return new Response(null, { status: 302, headers: { location: '/again' } });
      },
    });
    await expect(transport.downloadMedia('https://user:secret@media.example/')).rejects.toThrow(
      'Invalid provider request destination',
    );
    expect(sent).toEqual([]);
    await expect(transport.downloadMedia('https://media.example/again')).rejects.toThrow(
      'Media redirect limit exceeded',
    );
    expect(sent).toEqual(['https://media.example/again', 'https://media.example/again']);
  });

  it('closes a late fetch response after cancellation without returning its bytes', async () => {
    const started = deferred<void>();
    const pending = deferred<Response>();
    const closed = deferred<void>();
    const controller = new AbortController();
    const transport = createMediaTransport({
      maxBytes: 32,
      timeoutMs: 1_000,
      admit: async () => {},
      implementation: async () => {
        started.resolve();
        return pending.promise;
      },
    });
    const download = transport.downloadMedia('https://media.example/audio', { signal: controller.signal });
    await started.promise;
    controller.abort();
    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            closed.resolve();
          },
        }),
      ),
    );
    await closed.promise;
  });

  it('bounds hanging reader cleanup and preserves the original timeout', async () => {
    const transport = createMediaTransport({
      maxBytes: 32,
      timeoutMs: 20,
      admit: async () => {},
      implementation: async () => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) })),
    });
    await expect(transport.downloadMedia('https://media.example/audio')).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [{ name: 'TimeoutError' }, { name: 'TimeoutError' }],
    });
  });

  it('closes rejected responses without exposing their body or signed URL', async () => {
    let cancelled = false;
    const transport = createMediaTransport({
      maxBytes: 32,
      timeoutMs: 1_000,
      admit: async () => {},
      implementation: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('private details'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 403 },
        ),
    });
    await expect(transport.downloadMedia('https://media.example/audio?signature=private')).rejects.toThrow(
      /^Media download failed \(403\)$/,
    );
    expect(cancelled).toBe(true);
  });
});
