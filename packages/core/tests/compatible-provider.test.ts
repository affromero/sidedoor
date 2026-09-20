import { describe, expect, it } from 'vitest';
import { createCompatibleProvider } from '../src/ai/openai-compatible';
import type { GenerationEvent, ProviderDescriptor } from '../src/ai';

const descriptor: ProviderDescriptor = {
  id: 'compatible',
  label: 'Compatible',
  transport: 'api',
  fields: [],
  models: [],
  capabilities: ['text', 'vision', 'structured', 'tools'],
};
const request = {
  provider: 'compatible',
  model: 'selected-model',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'private prompt' }] }],
};
function stream(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
async function collect(events: AsyncIterable<GenerationEvent>) {
  const output: GenerationEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}
describe('OpenAI-compatible transport', () => {
  it('reports malformed construction defaults as configuration errors even with an endpoint override', async () => {
    const provider = createCompatibleProvider({
      descriptor,
      defaultBaseUrl: 'invalid endpoint',
      requiresKey: true,
    });
    expect(
      await provider.readiness({
        credentials: { baseUrl: 'https://selected.example/v1', compatibleApiKey: 'selected-key' },
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ code: 'not_configured', action: 'configure' });
  });
  it('reports unsafe endpoint configuration separately from missing credentials', async () => {
    const provider = createCompatibleProvider({
      descriptor,
      defaultBaseUrl: 'https://api.example/v1',
      requiresKey: true,
    });
    expect(
      await provider.readiness({
        credentials: { baseUrl: 'file:///tmp/provider', apiKey: 'selected-key' },
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ code: 'not_configured', action: 'configure' });
  });
  it.each([undefined, 'worksheet-v2', '', 'bad name', 'a'.repeat(65)])(
    'preserves valid schema names and rejects invalid ones: %s',
    async (schemaName) => {
      let body: Record<string, unknown> | undefined;
      const boundary: typeof fetch = async (input, init) => {
        body = JSON.parse(String(init?.body));
        return stream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
      };
      const selected = createCompatibleProvider({
        descriptor,
        defaultBaseUrl: 'https://api.example/v1',
        requiresKey: true,
        fetch: boundary,
      });
      const result = collect(
        selected.generate(
          { ...request, schema: { type: 'object' }, schemaName },
          { credentials: { apiKey: 'selected-key' }, signal: new AbortController().signal },
        ),
      );
      if (schemaName !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(schemaName)) {
        await expect(result).rejects.toMatchObject({ code: 'invalid_request' });
        expect(body).toBeUndefined();
        return;
      }
      await result;
      expect(body).toBeDefined();
      if (!body) throw new Error('Missing request');
      expect((body.response_format as { json_schema: { name: string } }).json_schema).toMatchObject({
        name: schemaName ?? 'result',
      });
    },
  );
  it.each(['', '   '])('rejects empty image references before network I/O: %s', async (url) => {
    let sent = false;
    const provider = createCompatibleProvider({
      descriptor,
      defaultBaseUrl: 'https://api.example/v1',
      requiresKey: false,
      fetch: async () => {
        sent = true;
        return Response.json({});
      },
    });
    await expect(
      collect(
        provider.generate(
          { ...request, messages: [{ role: 'user', content: [{ type: 'image_url', url }] }] },
          { credentials: {}, signal: new AbortController().signal },
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(sent).toBe(false);
  });
  it('rejects assistant images explicitly when the endpoint does not support them', async () => {
    let sent = false;
    const provider = createCompatibleProvider({
      descriptor,
      defaultBaseUrl: 'https://api.example/v1',
      requiresKey: false,
      fetch: async () => {
        sent = true;
        return Response.json({});
      },
    });
    await expect(
      collect(
        provider.generate(
          {
            ...request,
            messages: [
              { role: 'assistant', content: [{ type: 'image_url', url: 'https://images.example/a.png' }] },
            ],
          },
          { credentials: {}, signal: new AbortController().signal },
        ),
      ),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(sent).toBe(false);
  });
  it.each([
    'https://images.example/a.png?signature=A%2Fb&x=1',
    'data:image/png;base64,AQI=',
    'proxy:private-image',
  ])('preserves image references and roles without downloading them: %s', async (url) => {
    const destinations: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const boundary: typeof fetch = async (input, init) => {
      destinations.push(String(input));
      bodies.push(JSON.parse(String(init?.body)));
      return stream([{ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] }]);
    };
    const selected = createCompatibleProvider({
      descriptor,
      defaultBaseUrl: 'https://proxy.example/team/v1',
      requiresKey: true,
      assistantImages: true,
      fetch: boundary,
    });
    for (const role of ['user', 'assistant'] as const) {
      await collect(
        selected.generate(
          {
            ...request,
            messages: [
              {
                role,
                content: [
                  { type: 'text', text: 'describe' },
                  { type: 'image_url', url },
                ],
              },
            ],
          },
          { credentials: { apiKey: 'selected-key' }, signal: new AbortController().signal },
        ),
      );
      const body = bodies.at(-1)!;
      expect(body.messages).toMatchObject([
        {
          role,
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url } },
          ],
        },
      ]);
    }
    expect(destinations).toHaveLength(2);
    expect(destinations.every((destination) => destination !== url)).toBe(true);
  });
  it.each([undefined, 0, 0.7, -1, 3, NaN, Infinity, -Infinity])(
    'preserves finite temperature or rejects invalid input: %s',
    async (temperature) => {
      let sent = false;
      let body: Record<string, unknown> = {};
      const boundary: typeof fetch = async (input, init) => {
        sent = true;
        body = JSON.parse(String(init?.body));
        return stream([{ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] }]);
      };

      const selected = createCompatibleProvider({
        descriptor,
        defaultBaseUrl: 'https://api.example/v1',
        requiresKey: true,
        fetch: boundary,
      });
      const result = collect(
        selected.generate(
          { ...request, temperature },
          {
            credentials: { apiKey: 'selected-key' },
            signal: new AbortController().signal,
          },
        ),
      );
      if (temperature !== undefined && !Number.isFinite(temperature)) {
        await expect(result).rejects.toMatchObject({ code: 'invalid_request' });
        expect(sent).toBe(false);
        return;
      }
      await result;
      expect(sent).toBe(true);
      const settings = body;
      if (temperature === undefined) expect(settings).not.toHaveProperty('temperature');
      else expect(settings.temperature).toBe(temperature);
    },
  );
  it('discovers Ollama tags through a prefixed endpoint using its own credential', async () => {
    const requests: Request[] = [];
    const provider = createCompatibleProvider({
      descriptor: { ...descriptor, id: 'ollama' },
      defaultBaseUrl: 'http://localhost:11434/v1',
      requiresKey: false,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ models: [{ name: 'local-model' }] });
      },
    });
    const models = await provider.models({
      credentials: {
        baseUrl: 'https://models.example/team/v1',
        apiKey: 'official-secret',
        compatibleApiKey: 'endpoint-secret',
      },
      signal: new AbortController().signal,
    });
    expect(models.map((model) => model.id)).toEqual(['local-model']);
    expect(requests[0]?.url).toBe('https://models.example/team/api/tags');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer endpoint-secret');
  });
  it('rejects additional tool calls after a completion reason', async () => {
    const provider = createCompatibleProvider({
      descriptor,
      defaultBaseUrl: 'http://localhost:11434/v1',
      requiresKey: false,
      fetch: async () =>
        stream([
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'unexpected', function: { name: 'unexpected', arguments: '{}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
    });
    await expect(
      collect(provider.generate(request, { credentials: {}, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: 'invalid_stream' });
  });
  it('streams text and preserves final usage and structured-output settings', async () => {
    let body: Record<string, unknown> = {};
    const provider = createCompatibleProvider({
      descriptor,
      defaultBaseUrl: 'https://api.example/v1',
      requiresKey: true,
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://api.example/v1/chat/completions');
        body = JSON.parse(String(init?.body));
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-key');
        return stream([
          { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
          { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
        ]);
      },
    });
    const result = await collect(
      provider.generate(
        { ...request, schema: { type: 'object' }, effort: 'low' },
        { credentials: { apiKey: 'selected-key' }, signal: new AbortController().signal },
      ),
    );
    expect(result).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'finish', reason: 'complete', usage: { inputTokens: 12, outputTokens: 3 } },
    ]);
    expect(body).toMatchObject({
      model: 'selected-model',
      reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { strict: true, schema: { type: 'object' } } },
    });
  });
  it('assembles streamed tool arguments without reporting unknown usage as zero', async () => {
    const provider = createCompatibleProvider({
      descriptor,
      defaultBaseUrl: 'http://localhost:11434/v1',
      requiresKey: false,
      fetch: async () =>
        stream([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call1', function: { name: 'search', arguments: '{"query":' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '"papers"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
    });
    const result = await collect(
      provider.generate(request, { credentials: {}, signal: new AbortController().signal }),
    );
    expect(result).toEqual([
      { type: 'tool_call', id: 'call1', name: 'search', arguments: { query: 'papers' } },
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: null, outputTokens: null } },
    ]);
  });
  it('requires separately configured credentials for a custom endpoint', async () => {
    const provider = createCompatibleProvider({
      descriptor,
      defaultBaseUrl: 'https://api.example/v1',
      requiresKey: true,
      fetch: async () => {
        throw new Error('No request should leave before endpoint credentials are configured');
      },
    });
    await expect(
      collect(
        provider.generate(request, {
          credentials: { apiKey: 'official-secret', baseUrl: 'https://custom.example/v1' },
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('rejects a truncated stream instead of treating partial text as success', async () => {
    const provider = createCompatibleProvider({
      descriptor,
      defaultBaseUrl: 'http://localhost:11434/v1',
      requiresKey: false,
      fetch: async () => stream([{ choices: [{ delta: { content: 'partial' }, finish_reason: null }] }]),
    });
    await expect(
      collect(provider.generate(request, { credentials: {}, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: 'invalid_stream' });
  });
});
