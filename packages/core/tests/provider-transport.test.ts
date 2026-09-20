import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createProviderTransport } from '../src/providers/transport';
import OpenAI from 'openai';

const destination = 'https://api.play.ht/api/v2/tts/stream';
describe('provider execution transport', () => {
  it('does not invoke a transport cancelled by its dispatch observer', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled at dispatch');
    let invoked = false;
    const transport = createProviderTransport({
      rules: [{ method: 'POST', url: destination }],
      admit: async () => {},
      implementation: async () => {
        invoked = true;
        return new Response('unexpected');
      },
    });
    await expect(
      transport.authenticatedFetch(
        destination,
        { method: 'POST', signal: controller.signal },
        { onDispatch: () => controller.abort(reason) },
      ),
    ).rejects.toBe(reason);
    expect(invoked).toBe(false);
  });
  it.each(['rejected', 'observer-failed', 'transport-failed', 'success'] as const)(
    'reports transport invocation separately from admission when %s',
    async (mode) => {
      const rejection = new Error('Authority rejected');
      const observerFailure = new Error('Observer failed');
      const transportFailure = new Error('Transport failed synchronously');
      let dispatched = false;
      let invoked = false;
      const transport = createProviderTransport({
        rules: [{ method: 'POST', url: destination }],
        admit: async () => {
          if (mode === 'rejected') throw rejection;
        },
        implementation: () => {
          invoked = true;
          expect(dispatched).toBe(true);
          if (mode === 'transport-failed') throw transportFailure;
          return Promise.resolve(new Response('audio'));
        },
      });
      const result = transport.authenticatedFetch(
        destination,
        { method: 'POST' },
        {
          onDispatch: () => {
            if (mode === 'observer-failed') throw observerFailure;
            dispatched = true;
          },
        },
      );
      if (mode === 'success') expect(await (await result).text()).toBe('audio');
      else
        await expect(result).rejects.toBe(
          mode === 'rejected' ? rejection : mode === 'observer-failed' ? observerFailure : transportFailure,
        );
      expect(dispatched).toBe(mode === 'success' || mode === 'transport-failed');
      expect(invoked).toBe(dispatched);
    },
  );

  it('captures the dispatch observer before awaiting admission', async () => {
    let observed = false;
    const observation = {
      onDispatch: () => {
        observed = true;
      },
    };
    const transport = createProviderTransport({
      rules: [{ method: 'POST', url: destination }],
      admit: async () => {
        observation.onDispatch = () => {
          throw new Error('Replaced observer');
        };
      },
      implementation: async () => new Response('audio'),
    });
    await transport.authenticatedFetch(destination, { method: 'POST' }, observation);
    expect(observed).toBe(true);
  });
  it('reports consumption only after the complete response body is consumed', async () => {
    let settled = 0;
    const transport = createProviderTransport({
      rules: [{ method: 'POST', url: destination }],
      admit: async () => {},
      implementation: async () => {
        const response = new Response('audio');
        Object.defineProperties(response, {
          redirected: { configurable: true, value: false },
          type: { configurable: true, value: 'cors' },
          url: { configurable: true, value: destination },
        });
        return response;
      },
    });
    const response = await transport.authenticatedFetch(
      destination,
      { method: 'POST' },
      { onDispatch: () => {}, onConsumed: () => settled++ },
    );
    expect(settled).toBe(0);
    expect(response.url).toBe(destination);
    expect(response.type).toBe('cors');
    expect(response.redirected).toBe(false);
    expect((await response.arrayBuffer()).byteLength).toBe(5);
    expect(settled).toBe(1);
  });

  it('does not report consumption when response consumption is cancelled', async () => {
    let settled = false;
    const transport = createProviderTransport({
      rules: [{ method: 'POST', url: destination }],
      admit: async () => {},
      implementation: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
        ),
    });
    const response = await transport.authenticatedFetch(
      destination,
      { method: 'POST' },
      {
        onDispatch: () => {},
        onConsumed: () => {
          settled = true;
        },
      },
    );
    await response.body!.cancel();
    expect(settled).toBe(false);
    expect(response.body!.locked).toBe(false);
  });

  it('releases the owned reader when response consumption fails', async () => {
    let consumed = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('Response interrupted'));
      },
    });
    const transport = createProviderTransport({
      rules: [{ method: 'POST', url: destination }],
      admit: async () => {},
      implementation: async () => new Response(source),
    });
    const response = await transport.authenticatedFetch(
      destination,
      { method: 'POST' },
      {
        onDispatch: () => {},
        onConsumed: () => {
          consumed = true;
        },
      },
    );
    await expect(response.arrayBuffer()).rejects.toThrow('Response interrupted');
    expect(consumed).toBe(false);
    expect(source.locked).toBe(false);
  });
  it('preserves the captured account and body after admission and checks every retry', async () => {
    let allowed = true;
    const transmitted: string[] = [];
    const rules = [{ method: 'POST', url: destination }];
    const transport = createProviderTransport({
      rules,
      admit: async () => {
        if (!allowed) throw new Error('Access revoked');
      },
      implementation: async (input, init) => {
        const request = new Request(input, init);
        expect(request.headers.get('authorization')).toBe('captured-key');
        expect(request.redirect).toBe('error');
        transmitted.push(await request.text());
        return new Response('audio');
      },
    });
    rules[0]!.url = 'https://untrusted.example/';
    expect(
      await (
        await transport.authenticatedFetch(destination, {
          method: 'POST',
          headers: { authorization: 'captured-key' },
          body: 'speech',
        })
      ).text(),
    ).toBe('audio');
    allowed = false;
    await expect(transport.authenticatedFetch(destination, { method: 'POST' })).rejects.toThrow(
      'Access revoked',
    );
    expect(transmitted).toEqual(['speech']);
  });

  it.each([
    { url: 'https://untrusted.example/api/v2/tts/stream', method: 'POST' },
    { url: `${destination}/other`, method: 'POST' },
    { url: `${destination}?forward=elsewhere`, method: 'POST' },
    { url: destination, method: 'GET' },
    { url: `${destination}#fragment`, method: 'POST' },
  ])('rejects a destination outside the policy: $url $method', async ({ url, method }) => {
    let admitted = false;
    let transmitted = false;
    const transport = createProviderTransport({
      rules: [{ url: destination, method: 'POST' }],
      admit: async () => {
        admitted = true;
      },
      implementation: async () => {
        transmitted = true;
        return new Response();
      },
    });
    await expect(transport.authenticatedFetch(url, { method })).rejects.toThrow();
    expect({ admitted, transmitted }).toEqual({ admitted: false, transmitted: false });
  });

  it('allows explicit polling descendants without admitting sibling paths', async () => {
    const transport = createProviderTransport({
      rules: [{ url: 'https://api.replicate.com/v1/predictions/', method: 'GET', descendants: true }],
      admit: async () => {},
      implementation: async () => Response.json({ status: 'succeeded' }),
    });
    expect(
      await (await transport.authenticatedFetch('https://api.replicate.com/v1/predictions/job')).json(),
    ).toEqual({ status: 'succeeded' });
    await expect(
      transport.authenticatedFetch('https://api.replicate.com/v1/predictions-elsewhere/job'),
    ).rejects.toThrow();
  });

  it('does not transmit when cancelled during admission', async () => {
    const controller = new AbortController();
    let transmitted = false;
    const transport = createProviderTransport({
      rules: [{ url: destination, method: 'POST' }],
      signal: controller.signal,
      admit: async () => {
        controller.abort();
      },
      implementation: async () => {
        transmitted = true;
        return new Response();
      },
    });
    await expect(transport.authenticatedFetch(destination, { method: 'POST' })).rejects.toThrow();
    expect(transmitted).toBe(false);
  });

  it('closes a streamed upload rejected before dispatch', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const transport = createProviderTransport({
      rules: [{ url: destination, method: 'POST' }],
      admit: async () => {
        throw new Error('Revoked');
      },
    });
    const request = new Request(destination, { method: 'POST', body, duplex: 'half' } as RequestInit);
    await expect(transport.authenticatedFetch(request)).rejects.toThrow('Revoked');
    expect(cancelled).toBe(true);
  });

  it('stops waiting for an uncooperative fetch and closes its late response', async () => {
    const controller = new AbortController();
    let complete: (response: Response) => void = () => {
      throw new Error('Fetch has not started');
    };
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled = false;
    const transport = createProviderTransport({
      rules: [{ url: destination, method: 'POST' }],
      signal: controller.signal,
      admit: async () => {},
      implementation: () =>
        new Promise((resolve) => {
          complete = resolve;
          started();
        }),
    });
    const work = transport.authenticatedFetch(destination, { method: 'POST' });
    await ready;
    controller.abort(new Error('Cancelled'));
    await expect(work).rejects.toThrow('Cancelled');
    complete(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  it('reports a late cleanup failure after the caller receives cancellation', async () => {
    const controller = new AbortController();
    const failure = new Error('Cleanup failed');
    let report: (error: unknown) => void = () => {};
    const reported = new Promise<unknown>((resolve) => {
      report = resolve;
    });
    const transport = createProviderTransport({
      rules: [{ url: destination, method: 'POST' }],
      signal: controller.signal,
      admit: async () => {},
      onCleanupError: report,
      implementation: async () => {
        controller.abort(new Error('Cancelled'));
        return new Response(
          new ReadableStream({
            cancel() {
              throw failure;
            },
          }),
        );
      },
    });
    await expect(transport.authenticatedFetch(destination, { method: 'POST' })).rejects.toThrow('Cancelled');
    expect(await reported).toBe(failure);
  });

  it('bounds non-cooperative upload cleanup and retains the admission error', async () => {
    const rejected = new Error('Revoked authority');
    const transport = createProviderTransport({
      rules: [{ url: destination, method: 'POST' }],
      admit: async () => {
        throw rejected;
      },
    });
    const init = {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream({ cancel: () => new Promise<void>(() => {}) }),
    } as RequestInit;
    await expect(transport.authenticatedFetch(destination, init)).rejects.toMatchObject({
      errors: expect.arrayContaining([rejected]),
    });
  });

  it('bounds non-cooperative redirect cleanup and retains the redirect error', async () => {
    const transport = createProviderTransport({
      rules: [{ url: destination, method: 'POST' }],
      admit: async () => {},
      implementation: async () =>
        new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), { status: 302 }),
    });
    await expect(transport.authenticatedFetch(destination, { method: 'POST' })).rejects.toThrow('redirected');
  });

  it('preserves a real SDK multipart upload through injected fetch', async () => {
    let received:
      { model: FormDataEntryValue | null; bytes: string; authorization: string | null } | undefined;
    const transport = createProviderTransport({
      rules: [{ url: 'https://api.openai.com/v1/audio/transcriptions', method: 'POST' }],
      admit: async () => {},
      implementation: async (input, init) => {
        const request = new Request(input, init);
        const form = await request.formData();
        const file = form.get('file');
        if (!(file instanceof File)) throw new Error('Expected audio upload');
        received = {
          model: form.get('model'),
          bytes: await file.text(),
          authorization: request.headers.get('authorization'),
        };
        return Response.json({ text: 'Recognized speech' });
      },
    });
    const client = new OpenAI({ apiKey: 'captured-key', fetch: transport.authenticatedFetch, maxRetries: 0 });
    expect(
      await client.audio.transcriptions.create({
        model: 'whisper-1',
        file: new File(['audio bytes'], 'speech.wav', { type: 'audio/wav' }),
      }),
    ).toMatchObject({ text: 'Recognized speech' });
    expect(received).toEqual({
      model: 'whisper-1',
      bytes: 'audio bytes',
      authorization: 'Bearer captured-key',
    });
  });

  it('rejects redirects without sending credentials to the target and cancels an unfinished body', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/target' }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'audio/mpeg' });
      response.write('partial');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected HTTP fixture address');
    const base = `http://127.0.0.1:${address.port}`;
    const controller = new AbortController();
    try {
      const transport = createProviderTransport({
        rules: [
          { url: `${base}/redirect`, method: 'GET' },
          { url: `${base}/body`, method: 'GET' },
        ],
        admit: async () => {},
        signal: controller.signal,
      });
      await expect(
        transport.authenticatedFetch(`${base}/redirect`, { headers: { authorization: 'private-key' } }),
      ).rejects.toThrow();
      expect(requests).toEqual(['/redirect']);
      const response = await transport.authenticatedFetch(`${base}/body`);
      const body = response.arrayBuffer();
      controller.abort();
      await expect(body).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
