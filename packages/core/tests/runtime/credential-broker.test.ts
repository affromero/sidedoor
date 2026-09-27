import { request } from 'node:http';
import { access } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startCredentialBroker,
  type CredentialBroker,
  type CredentialBrokerOptions,
} from '../../src/runtime/credential-broker';

const brokers: CredentialBroker[] = [];
afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});
const body = { model: 'selected-model', max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }] };
async function broker(overrides: Partial<CredentialBrokerOptions> = {}) {
  const instance = await startCredentialBroker({
    executionId: 'execution-1',
    protocol: 'anthropic-messages',
    endpoint: 'https://api.example.test/v1/messages',
    model: 'selected-model',
    credential: 'real-provider-secret',
    expiresAt: Date.now() + 60_000,
    maxOutputTokens: 128,
    maxRequestBytes: 1024,
    maxResponseBytes: 4096,
    maxConcurrentRequests: 1,
    requestTimeoutMs: 2000,
    admit: async () => {},
    fetch: vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{"text":"hello"}', { headers: { 'content-type': 'application/json' } }),
      ),
    ...overrides,
  });
  brokers.push(instance);
  return instance;
}
function send(
  instance: CredentialBroker,
  data: unknown = body,
  options: { path?: string; token?: string; headers?: Record<string, string> } = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      {
        socketPath: instance.socketPath,
        path: options.path ?? '/v1/messages',
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token ?? instance.token}`,
          'content-type': 'application/json',
          ...options.headers,
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk: Buffer) => {
          text += chunk.toString();
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
        response.on('error', reject);
      },
    );
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify(data));
  });
}

describe('execution credential broker', () => {
  it('reports uncertain cleanup when an upstream adapter ignores cancellation', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const instance = await broker({
      fetch: async () => {
        started();
        return new Promise<Response>(() => {});
      },
    });
    const incoming = send(instance).catch(() => undefined);
    await ready;
    brokers.splice(brokers.indexOf(instance), 1);
    await expect(instance.close()).rejects.toThrow('cleanup could not be verified');
    await incoming;
    await expect(access(instance.directory)).rejects.toThrow();
  });
  it('rejects an expired grant and cancels oversized provider streams', async () => {
    await expect(broker({ expiresAt: Date.now() - 1 })).rejects.toThrow('expired');
    const instance = await broker({
      maxResponseBytes: 8,
      fetch: async () => new Response('x'.repeat(16), { headers: { 'content-type': 'application/json' } }),
    });
    await expect(send(instance)).rejects.toThrow();
  });

  it('aborts upstream work when the client disconnects', async () => {
    let connected!: () => void;
    const ready = new Promise<void>((resolve) => {
      connected = resolve;
    });
    let stopped!: () => void;
    const aborted = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const instance = await broker({
      fetch: async (_url, init) => {
        init?.signal?.addEventListener('abort', stopped, { once: true });
        connected();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
              init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const client = request({
      socketPath: instance.socketPath,
      path: '/v1/messages',
      method: 'POST',
      headers: { authorization: `Bearer ${instance.token}`, 'content-type': 'application/json' },
    });
    client.on('error', () => {});
    client.end(JSON.stringify(body));
    await ready;
    client.destroy();
    await aborted;
  });
  it('injects the provider credential only into the authorized upstream request', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{"answer":"hello"}', { headers: { 'content-type': 'application/json' } }),
      );
    const instance = await broker({ fetch: upstream });
    const result = await send(instance);
    expect(result).toEqual({ status: 200, body: '{"answer":"hello"}' });
    expect(instance.token).not.toContain('real-provider-secret');
    expect(upstream.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { 'x-api-key': 'real-provider-secret' },
      body: JSON.stringify(body),
    });
    await instance.close();
    await expect(access(instance.directory)).rejects.toThrow();
  });

  it.each([
    [{ ...body, model: 'other' }, {}],
    [{ ...body, max_tokens: 129 }, {}],
    [{ ...body, tools: [{ name: 'shell' }] }, {}],
    [{ ...body, arbitrary: true }, {}],
    [body, { path: '/v1/messages?redirect=elsewhere' }],
    [body, { headers: { 'x-api-key': 'attacker' } }],
  ])('denies unsupported protocol requests before upstream dispatch', async (data, options) => {
    const upstream = vi.fn<typeof fetch>();
    const instance = await broker({ fetch: upstream });
    expect((await send(instance, data, options)).status).toBe(400);
    expect(upstream.mock.calls).toHaveLength(0);
  });

  it('denies foreign execution tokens, revoked grants and oversized bodies', async () => {
    const instance = await broker({
      admit: async () => {
        throw new Error('revoked');
      },
    });
    expect((await send(instance, body, { token: 'foreign' })).status).toBe(401);
    expect((await send(instance)).status).toBe(403);
    expect(
      (await send(instance, { ...body, messages: [{ role: 'user', content: 'x'.repeat(2000) }] })).status,
    ).toBe(413);
  });

  it('streams successful provider events and suppresses provider error diagnostics', async () => {
    const instance = await broker({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response('data: {"text":"hi"}\n\ndata: [DONE]\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
        )
        .mockResolvedValueOnce(new Response('real-provider-secret', { status: 401 })),
    });
    expect((await send(instance, { ...body, stream: true })).body).toContain('data: [DONE]');
    const failed = await send(instance);
    expect(failed.status).toBe(502);
    expect(failed.body).not.toContain('real-provider-secret');
  });

  it('bounds concurrent attempts while an authorized upstream is pending', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (response: Response) => void;
    const waiting = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const instance = await broker({
      fetch: async () => {
        started();
        return waiting;
      },
    });
    const first = send(instance);
    await ready;
    expect((await send(instance)).status).toBe(429);
    release(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    expect((await first).status).toBe(200);
  });

  it('expires active admission without making a provider request', async () => {
    const upstream = vi.fn<typeof fetch>();
    const instance = await broker({
      requestTimeoutMs: 30,
      admit: () => new Promise<void>(() => {}),
      fetch: upstream,
    });
    await expect(send(instance)).rejects.toThrow();
    expect(upstream.mock.calls).toHaveLength(0);
  });
});
