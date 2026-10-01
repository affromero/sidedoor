import { afterEach, expect, it, vi } from 'vitest';
import {
  captureCompatibleApi,
  captureCompatibleModel,
  createSelectedApiRegistry,
} from '../../src/ai/configuration/providers';
import type { GenerationEvent } from '../../src/ai';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([undefined, 'private-endpoint-key'])(
  'uses an arbitrary compatible provider and its captured model with optional authentication: %s',
  async (apiKey) => {
    vi.stubEnv('OPENAI_API_KEY', 'unrelated-cloud-key');
    const input = {
      provider: 'research-server',
      label: 'Research server',
      endpoint: ' https://research.example/team/inference/ ',
      model: ' served:model ',
      apiKey,
      credentialBinding: apiKey
        ? { protocol: 'compatible', endpoint: 'https://research.example/team/inference' }
        : undefined,
    };
    const captured = captureCompatibleModel(input);
    input.endpoint = 'https://replacement.example/v1';
    input.model = 'replacement-model';
    input.apiKey = 'replacement-key';
    const destinations: string[] = [];
    const registry = createSelectedApiRegistry(captured, { streaming: false, maxRetries: 0 });
    vi.stubGlobal('fetch', async (url: URL | RequestInfo, init?: RequestInit) => {
      destinations.push(String(url));
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${apiKey ?? 'unused'}`);
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'served:model' });
      return Response.json({
        id: 'completion',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Captured answer' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      });
    });
    const events: GenerationEvent[] = [];
    for await (const event of registry.generate({
      provider: captured.descriptor.id,
      model: captured.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Question' }] }],
    }))
      events.push(event);
    expect(events).toContainEqual({ type: 'text', text: 'Captured answer' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'finish', usage: { inputTokens: 2, outputTokens: 3 } }),
    );
    expect(destinations).toEqual(['https://research.example/team/inference/chat/completions']);
  },
);

it.each([
  { protocol: 'compatible', endpoint: 'https://other.example/team/v1' },
  { protocol: 'compatible', endpoint: 'https://server.example/other/v1' },
  { protocol: 'responses', endpoint: 'https://server.example/team/v1' },
])('rejects a saved key bound to another endpoint or protocol: %j', (credentialBinding) => {
  expect(() =>
    captureCompatibleModel({
      provider: 'custom',
      label: 'Custom',
      model: 'selected-model',
      endpoint: 'https://server.example/team/v1',
      apiKey: 'saved-key',
      credentialBinding,
    }),
  ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
});

it.each([
  '',
  '  ',
  'file:///tmp/provider',
  'https://user:password@server.example/v1',
  'https://server.example/v1?tenant=private',
  'https://server.example/v1#fragment',
])('rejects unsafe or missing endpoint configuration: %s', (endpoint) => {
  expect(() => captureCompatibleApi({ provider: 'custom', label: 'Custom', endpoint })).toThrow(
    expect.objectContaining({ code: 'invalid_request' }),
  );
});

it.each(['', '   '])('requires a server model before generation: %s', (model) => {
  expect(() =>
    captureCompatibleModel({
      provider: 'custom',
      label: 'Custom',
      endpoint: 'http://localhost:8000/v1',
      model,
    }),
  ).toThrow(expect.objectContaining({ code: 'invalid_request' }));
});

it('captures required-key configuration without certifying or dispatching a missing key', async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Missing credentials must not reach a server');
  });
  const selection = captureCompatibleApi({
    provider: 'custom',
    label: 'Custom',
    endpoint: 'http://localhost:8000/v1',
    requiresKey: true,
  });
  expect(await createSelectedApiRegistry(selection).validateCredentials('custom')).toMatchObject({
    status: 'missing',
    readiness: { code: 'missing_credentials' },
  });
});

it('validates a captured compatible key without treating model reachability as authenticated proof', async () => {
  const selection = captureCompatibleApi({
    provider: 'custom',
    label: 'Custom',
    endpoint: 'https://server.example/team/v1/',
    apiKey: 'saved-key',
    requiresKey: true,
    credentialBinding: { protocol: 'compatible', endpoint: 'https://server.example/team/v1' },
  });
  vi.stubGlobal('fetch', async (url: URL | RequestInfo, init?: RequestInit) => {
    expect(String(url)).toBe('https://server.example/team/v1/models');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer saved-key');
    return Response.json({ object: 'list', data: [{ id: 'served-model' }] });
  });
  expect(await createSelectedApiRegistry(selection).validateCredentials('custom')).toMatchObject({
    status: 'inconclusive',
    readiness: { code: 'ready' },
  });
});

it('preserves cancellation before a compatible request reaches the server', async () => {
  const selection = captureCompatibleModel({
    provider: 'custom',
    label: 'Custom',
    endpoint: 'http://localhost:8000/v1',
    model: 'served-model',
  });
  const controller = new AbortController();
  controller.abort(new Error('Request cancelled'));
  vi.stubGlobal('fetch', () => {
    throw new Error('Cancelled requests must not reach a server');
  });
  const stream = createSelectedApiRegistry(selection).generate({
    provider: 'custom',
    model: selection.model,
    signal: controller.signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Question' }] }],
  });
  await expect(stream.next()).rejects.toThrow(/cancelled/);
});
