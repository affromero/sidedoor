import { afterEach, expect, it, vi } from 'vitest';
import { createSelectedApiRegistry, type SelectedApi } from '../../src/ai/configuration/providers';
import type { Capability, GenerationEvent, ProviderDescriptor } from '../../src/ai';

afterEach(() => vi.unstubAllGlobals());

it('preserves explicit Anthropic retries, search limits and provider timing', async () => {
  const registry = createSelectedApiRegistry(
    {
      transport: 'anthropic',
      descriptor: { ...descriptor(), capabilities: ['text', 'web'] },
      credentials: { apiKey: 'anthropic-owner-key' },
    },
    { streaming: false, maxRetries: 2, timeoutMode: 'provider', anthropic: { webSearchMaxUses: null } },
  );
  const attempts: string[] = [];
  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    attempts.push(String(input));
    expect(new Headers(init?.headers).get('x-api-key')).toBe('anthropic-owner-key');
    const body = JSON.parse(String(init?.body));
    expect(body.stream).not.toBe(true);
    expect(body.tools).toEqual([expect.objectContaining({ name: 'web_search' })]);
    expect(body.tools[0]).not.toHaveProperty('max_uses');
    if (attempts.length < 3)
      return Response.json(
        { type: 'error', error: { type: 'rate_limit_error', message: 'Retry later' } },
        { status: 429, headers: { 'retry-after': '0' } },
      );
    return Response.json({
      id: 'message',
      type: 'message',
      role: 'assistant',
      model: 'chosen-model',
      content: [{ type: 'text', text: 'Recovered answer' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 3 },
    });
  });
  const request = {
    provider: 'selected',
    model: 'chosen-model',
    allowWeb: true,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Question' }] }],
  };
  const invalid = registry.generate({ ...request, timeoutMs: 100 });
  await expect(invalid.next()).rejects.toMatchObject({ code: 'invalid_request' });
  expect(attempts).toEqual([]);
  const output: GenerationEvent[] = [];
  for await (const event of registry.generate(request)) output.push(event);
  expect(output).toContainEqual({ type: 'text', text: 'Recovered answer' });
  expect(attempts).toEqual(Array(3).fill('https://api.anthropic.com/v1/messages'));
});

function descriptor(): ProviderDescriptor {
  return {
    id: 'selected',
    label: 'Selected',
    transport: 'api',
    fields: [],
    models: [],
    capabilities: ['text'],
  };
}

it('uses one captured compatible endpoint and key for validation and generation', async () => {
  const capabilities: Capability[] = ['text'];
  const selection: SelectedApi = {
    transport: 'compatible',
    descriptor: { ...descriptor(), capabilities },
    credentials: { apiKey: 'original-key' },
    baseUrl: 'https://selected.example/team/v1',
    requiresKey: true,
  };
  const registry = createSelectedApiRegistry(selection, { streaming: false, maxRetries: 0 });
  selection.baseUrl = 'https://replacement.example/v1';
  selection.credentials.apiKey = 'replacement-key';
  selection.descriptor.id = 'replacement';
  capabilities.splice(0);
  const destinations: string[] = [];
  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    const destination = String(input);
    destinations.push(destination);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer original-key');
    if (destination.endsWith('/models')) return Response.json({ object: 'list', data: [] });
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'chosen-model' });
    return Response.json({
      id: 'completion',
      object: 'chat.completion',
      created: 1,
      model: 'chosen-model',
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Selected answer' } },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  });
  expect(await registry.validateCredentials('selected')).toMatchObject({
    status: 'inconclusive',
    readiness: { code: 'ready' },
  });
  const events: GenerationEvent[] = [];
  for await (const event of registry.generate({
    provider: 'selected',
    model: 'chosen-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Question' }] }],
  }))
    events.push(event);
  expect(events).toContainEqual({ type: 'text', text: 'Selected answer' });
  expect(destinations).toEqual([
    'https://selected.example/team/v1/models',
    'https://selected.example/team/v1/chat/completions',
  ]);
});

it('rejects a Responses credential endpoint override and uses its explicit construction endpoint', async () => {
  const destinations: string[] = [];
  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    destinations.push(String(input));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer endpoint-key');
    return Response.json({ object: 'list', data: [] });
  });
  const identity = descriptor();
  const unbound = createSelectedApiRegistry({
    transport: 'responses',
    descriptor: identity,
    credentials: { apiKey: 'official-key', baseUrl: 'https://custom.example/v1' },
  });
  expect(await unbound.validateCredentials('selected')).toMatchObject({
    status: 'inconclusive',
    readiness: { code: 'not_configured' },
  });
  expect(destinations).toEqual([]);
  const bound = createSelectedApiRegistry({
    transport: 'responses',
    descriptor: identity,
    baseUrl: 'https://custom.example/v1',
    credentials: {
      apiKey: 'endpoint-key',
    },
  });
  expect(await bound.validateCredentials('selected')).toMatchObject({
    status: 'inconclusive',
    readiness: { code: 'ready' },
  });
  expect(destinations).toEqual(['https://custom.example/v1/models']);
});

it('preserves explicit anonymous endpoint refusal to certify credentials', async () => {
  const registry = createSelectedApiRegistry({
    transport: 'compatible',
    descriptor: descriptor(),
    credentials: { allowAnonymous: true },
    baseUrl: 'http://localhost:8000/v1',
    requiresKey: false,
  });
  expect(await registry.validateCredentials('selected')).toMatchObject({
    status: 'inconclusive',
    readiness: { code: 'unsupported' },
  });
});
