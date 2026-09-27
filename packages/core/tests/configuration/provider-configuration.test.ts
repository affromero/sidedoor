import { afterEach, expect, it, vi } from 'vitest';
import { apiProviders } from '../../src/ai/configuration/providers';
import { providerDescriptors } from '../../src/ai/configuration/catalog';
import { ProviderRegistry, type CredentialValues } from '../../src/ai';

afterEach(() => vi.unstubAllGlobals());

it('executes Meta Standard with canonical authentication, structured output and usage', async () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://api.meta.ai/v1/chat/completions');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-meta-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'muse-spark-1.3',
      max_completion_tokens: 2048,
      response_format: { type: 'json_schema', json_schema: { name: 'result' } },
    });
    return Response.json({
      choices: [{ message: { content: '{"answer":"hola"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
  });
  const registry = new ProviderRegistry({
    providers: apiProviders({ streaming: false }),
    credentials: {
      async resolve() {
        return { apiKey: 'selected-meta-key' };
      },
    },
  });
  const events = [];
  for await (const event of registry.generate({
    provider: 'meta',
    model: 'muse-spark-1.3',
    maxOutputTokens: 2048,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello in Spanish.' }] }],
    schema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    },
  }))
    events.push(event);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: '{"answer":"hola"}' }),
      expect.objectContaining({ type: 'finish', usage: { inputTokens: 12, outputTokens: 4 } }),
    ]),
  );
});

function validate(provider: string, credentials: CredentialValues) {
  const adapter = apiProviders().find((item) => item.descriptor.id === provider);
  if (!adapter?.validateConfiguration) throw new Error('Provider must validate its configuration');
  adapter.validateConfiguration({ credentials, signal: new AbortController().signal });
}
it('adds canonical credential help for Google', () => {
  const google = providerDescriptors().find((provider) => provider.id === 'google');
  expect(google?.fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'apiKey',
        helpUrl: 'https://aistudio.google.com/apikey',
      }),
    ]),
  );
});
it('rejects official credentials for custom endpoints and accepts explicitly scoped endpoint keys', () => {
  for (const provider of ['openai', 'anthropic']) {
    expect(() => validate(provider, { apiKey: 'official-key' })).not.toThrow();
    expect(() =>
      validate(provider, { apiKey: 'official-key', baseUrl: 'https://custom.example/v1' }),
    ).toThrow('credentials');
    expect(() =>
      validate(provider, { compatibleApiKey: 'endpoint-key', baseUrl: 'https://custom.example/v1' }),
    ).not.toThrow();
  }
});
it('keeps keyless local configurations and explicit anonymous compatible endpoints usable', () => {
  for (const provider of ['ollama', 'llamacpp', 'vllm']) expect(() => validate(provider, {})).not.toThrow();
  expect(() =>
    validate('openai', { baseUrl: 'http://127.0.0.1:8080/v1', allowAnonymous: true }),
  ).not.toThrow();
  expect(() => validate('google', {})).toThrow();
});

it('does not certify credentials from anonymous or local endpoint reachability', async () => {
  const registry = new ProviderRegistry({
    providers: apiProviders(),
    credentials: {
      async resolve() {
        return { allowAnonymous: true, baseUrl: 'http://127.0.0.1:8080/v1' };
      },
    },
  });
  for (const provider of ['openai', 'ollama'])
    expect(await registry.validateCredentials(provider)).toMatchObject({
      status: 'inconclusive',
      readiness: { code: 'unsupported' },
    });
});
