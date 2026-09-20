import { describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { createAnthropicProvider } from '../src/ai/anthropic';
import { ProviderRegistry, type GenerationEvent, type ProviderDescriptor } from '../src/ai';

const descriptor: ProviderDescriptor = {
  id: 'anthropic',
  label: 'Anthropic',
  transport: 'api',
  fields: [],
  models: [],
  capabilities: ['text', 'vision', 'structured', 'tools', 'web'],
};
it('reports malformed Anthropic endpoints as configuration faults without probing', async () => {
  const provider = createAnthropicProvider({
    descriptor,
    fetch: async () => {
      throw new Error('Unexpected HTTP request');
    },
  });
  expect(
    await provider.readiness({
      credentials: { apiKey: 'selected-key', baseUrl: 'invalid endpoint' },
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ code: 'not_configured', action: 'configure' });
});
function response(reason = 'end_turn', content = 'Hello', cacheWrite: number | null = 3) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg1',
        type: 'message',
        role: 'assistant',
        model: 'chosen-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: cacheWrite,
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: 2 } },
    },
    { type: 'message_stop' },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const request = {
  provider: 'anthropic',
  model: 'chosen-model',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'private prompt' }] }],
};
const context = () => ({ credentials: { apiKey: 'selected-key' }, signal: new AbortController().signal });
async function collect(events: AsyncIterable<GenerationEvent>) {
  const values: GenerationEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

describe('Anthropic transport', () => {
  it.each(['request', 'provider'] as const)(
    'preserves the selected deadline policy: %s',
    async (timeoutMode) => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      const clock = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms) => timeout(ms === 600_000 ? 10 : ms));
      try {
        const adapter = createAnthropicProvider({
          descriptor,
          maxRetries: 0,
          fetch: async (input, init) => {
            await delay(40, undefined, { signal: init?.signal ?? undefined });
            return response();
          },
        });
        const registry = new ProviderRegistry({
          providers: [adapter],
          timeoutMode,
          credentials: {
            async resolve() {
              return { apiKey: 'selected-key' };
            },
          },
        });
        const result = collect(registry.generate(request));
        if (timeoutMode === 'request') await expect(result).rejects.toThrow();
        else expect(await result).toContainEqual({ type: 'text', text: 'Hello' });
      } finally {
        clock.mockRestore();
      }
    },
  );
  it('rejects an explicit whole-request timeout in provider timing mode', async () => {
    let sent = false;
    const registry = new ProviderRegistry({
      timeoutMode: 'provider',
      providers: [
        createAnthropicProvider({
          descriptor,
          fetch: async () => {
            sent = true;
            return response();
          },
        }),
      ],
      credentials: {
        async resolve() {
          return { apiKey: 'selected-key' };
        },
      },
    });
    await expect(collect(registry.generate({ ...request, timeoutMs: 100 }))).rejects.toThrow(
      'no request timeout',
    );
    expect(sent).toBe(false);
  });
  it('rejects custom tools that collide with hosted search before network access', async () => {
    let sent = false;
    const provider = createAnthropicProvider({
      descriptor,
      fetch: async () => {
        sent = true;
        return response();
      },
    });
    await expect(
      collect(
        provider.generate(
          {
            ...request,
            allowWeb: true,
            tools: [
              {
                name: 'web_search',
                description: 'Custom search',
                schema: { type: 'object' },
              },
            ],
          },
          context(),
        ),
      ),
    ).rejects.toThrow('Custom tools cannot use');
    expect(sent).toBe(false);
  });
  it.each([null, 7])('preserves per-request search restrictions and explicit limits: %s', async (maxUses) => {
    const provider = createAnthropicProvider({
      descriptor,
      fetch: async (input, init) => {
        expect(JSON.parse(String(init?.body)).tools).toEqual([
          {
            type: 'web_search_20250305',
            name: 'web_search',
            allowed_domains: ['example.com'],
            blocked_domains: null,
            max_uses: maxUses,
            user_location: {
              type: 'approximate',
              city: 'Chicago',
              country: 'US',
              region: null,
              timezone: 'America/Chicago',
            },
          },
        ]);
        return response();
      },
    });
    const events = await collect(
      provider.generate(
        {
          ...request,
          allowWeb: true,
          webSearch: {
            allowedDomains: ['example.com'],
            blockedDomains: null,
            maxUses,
            userLocation: {
              type: 'approximate',
              city: 'Chicago',
              country: 'US',
              region: null,
              timezone: 'America/Chicago',
            },
          },
        },
        context(),
      ),
    );
    expect(events).toContainEqual({ type: 'text', text: 'Hello' });
  });
  it.each([
    { allowWeb: false, webSearch: { allowedDomains: ['example.com'] } },
    { allowWeb: true, webSearch: { allowedDomains: ['example.com'], blockedDomains: ['other.com'] } },
    { allowWeb: true, webSearch: { maxUses: 0 } },
  ])('rejects invalid search settings before network access: %j', async (settings) => {
    let sent = false;
    const provider = createAnthropicProvider({
      descriptor,
      fetch: async () => {
        sent = true;
        return response();
      },
    });
    await expect(collect(provider.generate({ ...request, ...settings }, context()))).rejects.toThrow();
    expect(sent).toBe(false);
  });
  it('preserves final usage when a completed response is refused', async () => {
    const provider = createAnthropicProvider({ descriptor, fetch: async () => response('refusal') });
    const error = await collect(provider.generate(request, context())).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(usageFromGenerationError(error)).toMatchObject({ inputTokens: 15, outputTokens: 5 });
  });
  it('does not report completed earlier rounds as the total of a failed later round', async () => {
    let first = true;
    const provider = createAnthropicProvider({
      descriptor,
      maxRetries: 0,
      fetch: async () => {
        if (first) {
          first = false;
          return response('pause_turn');
        }
        return Response.json(
          { error: { type: 'overloaded_error', message: 'Unavailable' } },
          { status: 529 },
        );
      },
    });
    const error = await collect(provider.generate(request, context())).catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 529 });
    expect(usageFromGenerationError(error)).toMatchObject({ inputTokens: null, outputTokens: null });
  });
  it.each([undefined, null, 7])('preserves configured web search limits: %s', async (webSearchMaxUses) => {
    const bodies: Record<string, unknown>[] = [];
    const selected = createAnthropicProvider({
      descriptor,
      webSearchMaxUses,
      fetch: async (input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response();
      },
    });
    await collect(selected.generate({ ...request, allowWeb: true }, context()));
    const tools = bodies[0]?.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    if (webSearchMaxUses === null) expect(tools[0]).not.toHaveProperty('max_uses');
    else expect(tools[0]?.max_uses).toBe(webSearchMaxUses ?? 3);
    await collect(selected.generate(request, context()));
    expect(bodies[1]).not.toHaveProperty('tools');
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid web limits at construction: %s',
    (webSearchMaxUses) => {
      expect(() => createAnthropicProvider({ descriptor, webSearchMaxUses })).toThrow(
        'positive safe integer',
      );
    },
  );
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
      return response();
    };
    const selected = createAnthropicProvider({ descriptor, fetch: boundary });
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
            { type: 'image', source: { type: 'url', url } },
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
        return response();
      };

      const selected = createAnthropicProvider({ descriptor, fetch: boundary });
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
  it('keeps inclusive input usage unknown when cache creation was not measured', async () => {
    const provider = createAnthropicProvider({
      descriptor,
      fetch: async () => response('end_turn', 'Hello', null),
    });
    const events = await collect(provider.generate(request, context()));
    expect(events.at(-1)).toMatchObject({
      type: 'finish',
      usage: { inputTokens: null, outputTokens: 5, cachedInputTokens: 2, cacheWriteTokens: null },
    });
  });
  it('enables adaptive thinking without overriding the provider default effort', async () => {
    const provider = createAnthropicProvider({
      descriptor,
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.thinking).toEqual({ type: 'adaptive' });
        expect(body.output_config).not.toHaveProperty('effort');
        return response();
      },
    });
    expect(
      await collect(provider.generate({ ...request, adaptiveThinking: true }, context())),
    ).toContainEqual({ type: 'text', text: 'Hello' });
  });
  it('preserves web search, effort, schema and separate cached usage', async () => {
    const provider = createAnthropicProvider({
      descriptor,
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
        expect(new Headers(init?.headers).get('x-api-key')).toBe('selected-key');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: 'chosen-model',
          thinking: { type: 'adaptive' },
          output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
          tools: [{ name: 'web_search' }],
        });
        return response('end_turn', '{}');
      },
    });
    const events = await collect(
      provider.generate(
        { ...request, effort: 'high', allowWeb: true, schema: { type: 'object' } },
        context(),
      ),
    );
    expect(events.filter((event) => event.type !== 'continuation')).toEqual([
      { type: 'text', text: '{}' },
      {
        type: 'finish',
        reason: 'complete',
        usage: {
          inputTokens: 15,
          outputTokens: 5,
          cachedInputTokens: 2,
          cacheWriteTokens: 3,
          reasoningTokens: 2,
        },
      },
    ]);
  });
  it('continues a paused server-tool turn and sums its measured usage', async () => {
    let round = 0;
    const provider = createAnthropicProvider({
      descriptor,
      fetch: async (url, init) => {
        expect(String(url)).toContain('/messages');
        if (round++ === 0) return response('pause_turn', 'Searching. ');
        expect(JSON.parse(String(init?.body)).messages).toContainEqual({
          role: 'assistant',
          content: [{ type: 'text', text: 'Searching. ' }],
        });
        return response('end_turn', 'Found it.');
      },
    });
    const events = await collect(provider.generate({ ...request, allowWeb: true }, context()));
    expect(events.at(-1)).toMatchObject({
      type: 'finish',
      reason: 'complete',
      usage: { inputTokens: 30, outputTokens: 10, reasoningTokens: 4 },
    });
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: 'Searching. ' },
      { type: 'text', text: 'Found it.' },
    ]);
  });
  it('rejects a claimed JSON-object result when the returned text is invalid', async () => {
    const provider = createAnthropicProvider({
      descriptor,
      fetch: async () => response('end_turn', 'not JSON'),
    });
    await expect(
      collect(provider.generate({ ...request, responseFormat: 'json_object' }, context())),
    ).rejects.toThrow();
  });
});
import { usageFromGenerationError } from '../src/ai/usage';
