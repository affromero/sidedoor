import { describe, expect, it } from 'vitest';
import { createResponsesProvider } from '../../src/ai/providers/openai-responses';
import type { GenerationEvent, ProviderDescriptor } from '../../src/ai';

const descriptor: ProviderDescriptor = {
  id: 'openai',
  label: 'OpenAI',
  transport: 'api',
  models: [],
  fields: [],
  capabilities: ['text', 'vision', 'structured', 'tools', 'web'],
};
const request = {
  provider: 'openai',
  model: 'chosen-model',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'private question' }] }],
};
const context = () => ({ credentials: { apiKey: 'selected-key' }, signal: new AbortController().signal });
function stream(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
async function collect(events: AsyncIterable<GenerationEvent>) {
  const values: GenerationEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

describe('OpenAI Responses transport', () => {
  it('reports conflicting Responses endpoints without blaming a configured key', async () => {
    const provider = createResponsesProvider({ descriptor });
    expect(
      await provider.readiness({
        credentials: { apiKey: 'selected-key', baseUrl: 'https://other.example/v1' },
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ code: 'not_configured', action: 'configure' });
  });
  it.each(['https://proxy.example/team', 'https://proxy.example/team/'])(
    'uses an explicitly configured Responses endpoint: %s',
    async (defaultBaseUrl) => {
      const provider = createResponsesProvider({
        descriptor,
        defaultBaseUrl,
        fetch: async (input, init) => {
          expect(String(input)).toBe('https://proxy.example/team/responses');
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-key');
          return stream([
            { type: 'response.completed', response: { id: 'done', status: 'completed', output: [] } },
          ]);
        },
      });
      await collect(
        provider.generate(request, {
          ...context(),
          credentials: { apiKey: 'selected-key', baseUrl: 'https://proxy.example/team/' },
        }),
      );
      await expect(
        collect(
          provider.generate(request, {
            ...context(),
            credentials: { apiKey: 'selected-key', baseUrl: 'https://elsewhere.example/team' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    },
  );
  it.each([undefined, 'web_search_preview' as const])(
    'preserves the selected hosted search tool: %s',
    async (webSearchType) => {
      const provider = createResponsesProvider({
        descriptor,
        webSearchType,
        fetch: async (input, init) => {
          expect(String(input)).toBe('https://api.openai.com/v1/responses');
          expect(JSON.parse(String(init?.body))).toMatchObject({
            tools: [{ type: webSearchType ?? 'web_search' }],
          });
          return stream([
            { type: 'response.completed', response: { id: 'done', status: 'completed', output: [] } },
          ]);
        },
      });
      await collect(provider.generate({ ...request, allowWeb: true }, context()));
    },
  );
  it('retains the first terminal measurement when a duplicate response conflicts', async () => {
    const provider = createResponsesProvider({
      descriptor,
      fetch: async () =>
        stream(
          [12, 99].map((input_tokens) => ({
            type: 'response.completed',
            response: {
              id: 'done',
              status: 'completed',
              output: [],
              usage: { input_tokens, output_tokens: 3 },
            },
          })),
        ),
    });
    const error = await collect(provider.generate(request, context())).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(usageFromGenerationError(error)).toMatchObject({ inputTokens: 12, outputTokens: 3 });
  });
  it.each(['response.failed', 'response.completed'])(
    'preserves terminal failure measurements before validating output: %s',
    async (type) => {
      const provider = createResponsesProvider({
        descriptor,
        fetch: async () =>
          stream([
            {
              type,
              response: {
                id: 'failed',
                status: type === 'response.failed' ? 'failed' : 'completed',
                usage: { input_tokens: 12, output_tokens: 3 },
                output: [{ type: 'function_call', call_id: 'bad', name: 'lookup', arguments: '{' }],
              },
            },
          ]),
      });
      const error = await collect(provider.generate(request, context())).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(usageFromGenerationError(error)).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    },
  );
  it('retains assistant images and tool calls when resuming a stateless turn', async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = createResponsesProvider({
      descriptor,
      fetch: async (input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return stream([
          { type: 'response.completed', response: { id: 'done', status: 'completed', output: [] } },
        ]);
      },
    });
    const first = await collect(
      provider.generate(
        {
          ...request,
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'image_url', url: 'https://images.example/a.png?signature=A%2Fb' }],
              toolCalls: [{ id: 'lookup-1', name: 'lookup', arguments: { query: 'image' } }],
            },
          ],
        },
        context(),
      ),
    );
    const continuation = first.find((event) => event.type === 'continuation');
    if (!continuation || continuation.type !== 'continuation') throw new Error('Missing continuation');
    await collect(
      provider.generate(
        {
          ...request,
          continuation,
          messages: [{ role: 'tool', toolCallId: 'lookup-1', content: [{ type: 'text', text: 'found' }] }],
        },
        context(),
      ),
    );
    expect(bodies[1]?.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'input_image', detail: 'auto', image_url: 'https://images.example/a.png?signature=A%2Fb' },
        ],
      },
      { type: 'function_call', call_id: 'lookup-1', name: 'lookup', arguments: '{"query":"image"}' },
      { type: 'function_call_output', call_id: 'lookup-1', output: 'found' },
    ]);
  });
  it.each([undefined, 'worksheet-v2', '', 'bad name', 'a'.repeat(65)])(
    'preserves valid schema names and rejects invalid ones: %s',
    async (schemaName) => {
      let body: Record<string, unknown> | undefined;
      const boundary: typeof fetch = async (input, init) => {
        body = JSON.parse(String(init?.body));
        return stream([
          { type: 'response.completed', response: { id: 'done', status: 'completed', output: [] } },
        ]);
      };
      const selected = createResponsesProvider({ descriptor, fetch: boundary });
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
      expect((body.text as { format: { name: string } }).format).toMatchObject({
        name: schemaName ?? 'result',
      });
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
      return stream([
        { type: 'response.completed', response: { id: 'done', status: 'completed', output: [] } },
      ]);
    };
    const selected = createResponsesProvider({ descriptor, fetch: boundary });
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
      expect(body.input).toMatchObject([
        {
          role,
          content: [
            { type: 'input_text', text: 'describe' },
            { type: 'input_image', detail: 'auto', image_url: url },
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
        return stream([
          { type: 'response.completed', response: { id: 'done', status: 'completed', output: [] } },
        ]);
      };

      const selected = createResponsesProvider({ descriptor, fetch: boundary });
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
  it('rejects a terminal refusal even when no refusal delta preceded it', async () => {
    const provider = createResponsesProvider({
      descriptor,
      fetch: async () =>
        stream([
          {
            type: 'response.completed',
            response: {
              id: 'refused',
              status: 'completed',
              output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot answer' }] }],
            },
          },
        ]),
    });
    await expect(collect(provider.generate(request, context()))).rejects.toThrow('refused');
  });
  it('supports a non-streaming response while preserving text and measured usage', async () => {
    const provider = createResponsesProvider({
      descriptor,
      streaming: false,
      fetch: async (url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ stream: false, store: false });
        return Response.json({
          id: 'response1',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'message1',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Complete answer', annotations: [] }],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 3 },
        });
      },
    });
    const events = await collect(provider.generate(request, context()));
    expect(events).toContainEqual({ type: 'text', text: 'Complete answer' });
    expect(events.at(-1)).toMatchObject({
      type: 'finish',
      reason: 'complete',
      usage: { inputTokens: 2, outputTokens: 3 },
    });
  });
  it('keeps encrypted reasoning and tool context across a stateless continuation', async () => {
    let second = false;
    const reasoning = {
      type: 'reasoning',
      id: 'reasoning1',
      summary: [],
      encrypted_content: 'opaque-reasoning',
    };
    const call = { type: 'function_call', call_id: 'call1', name: 'lookup', arguments: '{"id":"paper"}' };
    const provider = createResponsesProvider({
      descriptor,
      fetch: async (url, init) => {
        expect(String(url)).toBe('https://api.openai.com/v1/responses');
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });
        if (!second) {
          second = true;
          expect(body.tools).toContainEqual({ type: 'web_search' });
          return stream([
            {
              type: 'response.completed',
              response: {
                output: [reasoning, call],
                usage: {
                  input_tokens: 10,
                  output_tokens: 4,
                  input_tokens_details: { cached_tokens: 2 },
                  output_tokens_details: { reasoning_tokens: 3 },
                },
              },
            },
          ]);
        }
        expect(body.input).toContainEqual(reasoning);
        expect(body.input).toContainEqual(call);
        expect(body.input).toContainEqual({
          type: 'function_call_output',
          call_id: 'call1',
          output: 'paper details',
        });
        return stream([
          { type: 'response.output_text.delta', delta: 'Result' },
          {
            type: 'response.completed',
            response: {
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text: 'Result',
                      annotations: [
                        {
                          type: 'url_citation',
                          url: 'https://example.org/paper',
                          title: 'Paper',
                          start_index: 0,
                          end_index: 6,
                        },
                      ],
                    },
                  ],
                },
              ],
              usage: {
                input_tokens: 15,
                output_tokens: 6,
                input_tokens_details: { cached_tokens: 4 },
                output_tokens_details: { reasoning_tokens: 2 },
              },
            },
          },
        ]);
      },
    });
    const first = await collect(
      provider.generate(
        {
          ...request,
          allowWeb: true,
          tools: [{ name: 'lookup', description: 'Find a paper', schema: { type: 'object' } }],
        },
        context(),
      ),
    );
    expect(first).toContainEqual({
      type: 'tool_call',
      id: 'call1',
      name: 'lookup',
      arguments: { id: 'paper' },
    });
    const continuation = first.find((event) => event.type === 'continuation');
    if (continuation?.type !== 'continuation') throw new Error('No continuation state');
    const final = await collect(
      provider.generate(
        {
          ...request,
          continuation,
          messages: [
            { role: 'tool', toolCallId: 'call1', content: [{ type: 'text', text: 'paper details' }] },
          ],
        },
        context(),
      ),
    );
    expect(final).toContainEqual({ type: 'text', text: 'Result' });
    expect(final).toContainEqual({
      type: 'citation',
      url: 'https://example.org/paper',
      title: 'Paper',
      start: 0,
      end: 6,
    });
    expect(final.at(-1)).toMatchObject({
      type: 'finish',
      reason: 'complete',
      usage: { inputTokens: 15, outputTokens: 6, cachedInputTokens: 4, reasoningTokens: 2 },
    });
  });
  it('rejects a transcript from another model before sending it upstream', async () => {
    const provider = createResponsesProvider({
      descriptor,
      fetch: async () => {
        throw new Error('Mismatched transcript must not be sent');
      },
    });
    await expect(
      collect(
        provider.generate(
          { ...request, continuation: { provider: 'openai', model: 'another-model', data: [] } },
          context(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('reports interrupted streams as failures', async () => {
    const provider = createResponsesProvider({
      descriptor,
      fetch: async () => stream([{ type: 'response.output_text.delta', delta: 'unfinished' }]),
    });
    await expect(collect(provider.generate(request, context()))).rejects.toMatchObject({
      code: 'invalid_stream',
    });
  });
});
import { usageFromGenerationError } from '../../src/ai/usage';
