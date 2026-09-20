import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogleProvider } from '../../src/ai/providers/google';
import type { GenerationEvent, GenerationRequest } from '../../src/ai';

const provider = createGoogleProvider({
  id: 'google',
  label: 'Google',
  transport: 'api',
  capabilities: ['text', 'vision', 'structured', 'tools', 'web'],
  fields: [],
  models: [],
});
const request: GenerationRequest = {
  provider: 'google',
  model: 'selected-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'private prompt' }] }],
};
const context = () => ({ credentials: { apiKey: 'selected-key' }, signal: new AbortController().signal });
function response(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
async function collect(events: AsyncIterable<GenerationEvent>) {
  const result: GenerationEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
afterEach(() => vi.unstubAllGlobals());

describe('Google transport', () => {
  it('reports forbidden endpoint overrides as configuration errors before HTTP', async () => {
    expect(
      await provider.readiness({
        credentials: { apiKey: 'selected-key', baseUrl: 'https://other.example' },
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ code: 'not_configured', action: 'configure' });
  });
  it.each([401, 403, 429, 503])(
    'does not confuse permission or availability failures with rejected credentials: %s',
    async (status) => {
      vi.stubGlobal('fetch', async () =>
        Response.json(
          {
            error: {
              code: status,
              message: 'Probe failed',
              status: status === 403 ? 'PERMISSION_DENIED' : 'UNKNOWN',
            },
          },
          { status },
        ),
      );
      expect(await provider.readiness(context())).toMatchObject({
        code: status === 401 ? 'not_authenticated' : 'unreachable',
        action: status === 401 || status === 403 ? 'configure' : 'retry',
      });
    },
  );

  it.each([true, false])(
    'preserves terminal usage but does not promote partial metadata on failure: %s',
    async (terminal) => {
      vi.stubGlobal('fetch', async () =>
        response([
          {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'not json' }] },
                ...(terminal ? { finishReason: 'STOP' } : {}),
              },
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
          },
        ]),
      );
      const error = await collect(
        provider.generate({ ...request, schema: { type: 'object' } }, context()),
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(usageFromGenerationError(error)).toMatchObject({
        inputTokens: terminal ? 10 : null,
        outputTokens: terminal ? 2 : null,
      });
    },
  );
  it('rejects URL images without downloading them or sending a generation request', async () => {
    let sent = false;
    vi.stubGlobal('fetch', async () => {
      sent = true;
      return Response.json({});
    });
    await expect(
      collect(
        provider.generate(
          {
            ...request,
            messages: [
              { role: 'user', content: [{ type: 'image_url', url: 'https://images.example/a.png' }] },
            ],
          },
          context(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(sent).toBe(false);
  });
  it.each([undefined, 0, 0.7, -1, 3, NaN, Infinity, -Infinity])(
    'preserves finite temperature or rejects invalid input: %s',
    async (temperature) => {
      let sent = false;
      let body: Record<string, unknown> = {};
      const boundary: typeof fetch = async (input, init) => {
        sent = true;
        body = JSON.parse(String(init?.body));
        return response([
          { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }] },
        ]);
      };
      vi.stubGlobal('fetch', boundary);
      const selected = provider;
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
      const settings = (body.generationConfig ?? {}) as Record<string, unknown>;
      if (temperature === undefined) expect(settings).not.toHaveProperty('temperature');
      else expect(settings.temperature).toBe(temperature);
    },
  );
  it.each([
    [{ totalTokenCount: 12 }, { inputTokens: 10, outputTokens: 2 }],
    [
      { totalTokenCount: 20, thoughtsTokenCount: 3 },
      { inputTokens: 15, outputTokens: 5 },
    ],
    [
      { totalTokenCount: 20, toolUsePromptTokenCount: 5 },
      { inputTokens: 15, outputTokens: 5 },
    ],
    [{ totalTokenCount: 20 }, { inputTokens: null, outputTokens: null }],
    [
      { totalTokenCount: 12, thoughtsTokenCount: 3, toolUsePromptTokenCount: 4 },
      { inputTokens: null, outputTokens: null },
    ],
  ])(
    'uses authoritative total evidence without guessing missing partitions: %j',
    async (metadata, expected) => {
      vi.stubGlobal('fetch', async () =>
        response([
          {
            candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, ...metadata },
          },
        ]),
      );
      expect((await collect(provider.generate(request, context()))).at(-1)).toMatchObject({
        type: 'finish',
        usage: expected,
      });
    },
  );
  it('keeps totals unknown when tool input and reasoning were not measured', async () => {
    vi.stubGlobal('fetch', async () =>
      response([
        {
          candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        },
      ]),
    );
    expect((await collect(provider.generate(request, context()))).at(-1)).toMatchObject({
      type: 'finish',
      usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null },
    });
  });
  it('preserves schema, image inputs, effort and measured cache and reasoning usage', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(String(url)).toContain(
        'https://generativelanguage.googleapis.com/v1beta/models/selected-model:streamGenerateContent',
      );
      expect(new Headers(init.headers).get('x-goog-api-key')).toBe('selected-key');
      expect(JSON.parse(String(init.body))).toMatchObject({
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: { type: 'object' },
          thinkingConfig: { thinkingLevel: 'HIGH' },
        },
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AQI=' } }] }],
      });
      return response([
        {
          candidates: [{ content: { role: 'model', parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
            cachedContentTokenCount: 3,
            thoughtsTokenCount: 4,
            toolUsePromptTokenCount: 5,
          },
        },
      ]);
    });
    const events = await collect(
      provider.generate(
        {
          ...request,
          schema: { type: 'object' },
          effort: 'high',
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', mediaType: 'image/png', data: new Uint8Array([1, 2]) }],
            },
          ],
        },
        context(),
      ),
    );
    expect(events.at(-1)).toEqual({
      type: 'finish',
      reason: 'complete',
      usage: { inputTokens: 15, outputTokens: 6, cachedInputTokens: 3, reasoningTokens: 4 },
    });
  });

  it('retains private thought signatures across a tool continuation without exposing thinking as text', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(String(url)).toContain(':streamGenerateContent');
      const body = JSON.parse(String(init.body));
      if (body.contents.length > 1) {
        expect(body.contents).toContainEqual({
          role: 'model',
          parts: [
            { thought: true, text: 'private reasoning', thoughtSignature: 'signed-thought' },
            {
              functionCall: { id: 'call1', name: 'lookup', args: { query: 'value' } },
              thoughtSignature: 'signed-call',
            },
          ],
        });
        expect(body.contents.at(-1)).toEqual({
          role: 'user',
          parts: [{ functionResponse: { id: 'call1', name: 'lookup', response: { result: 'found' } } }],
        });
        return response([
          { candidates: [{ content: { role: 'model', parts: [{ text: 'Answer' }] }, finishReason: 'STOP' }] },
        ]);
      }
      return response([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { thought: true, text: 'private reasoning', thoughtSignature: 'signed-thought' },
                  {
                    functionCall: { id: 'call1', name: 'lookup', args: { query: 'value' } },
                    thoughtSignature: 'signed-call',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ]);
    });
    const events = await collect(provider.generate(request, context()));
    expect(events.filter((event) => event.type === 'text')).toEqual([]);
    expect(events).toContainEqual({
      type: 'tool_call',
      id: 'call1',
      name: 'lookup',
      arguments: { query: 'value' },
    });
    const continuation = events.find((event) => event.type === 'continuation');
    if (continuation?.type !== 'continuation') throw new Error('Missing continuation');
    const resumed = await collect(
      provider.generate(
        {
          ...request,
          continuation,
          messages: [{ role: 'tool', toolCallId: 'call1', content: [{ type: 'text', text: 'found' }] }],
        },
        context(),
      ),
    );
    expect(resumed).toContainEqual({ type: 'text', text: 'Answer' });
  });

  it('fails on a truncated stream instead of accepting partial text', async () => {
    vi.stubGlobal('fetch', async () =>
      response([{ candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] }]),
    );
    await expect(collect(provider.generate(request, context()))).rejects.toMatchObject({
      code: 'invalid_stream',
    });
  });

  it('discovers generation models across all pages', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const next = String(url).includes('pageToken=next');
      return Response.json(
        next
          ? {
              models: [
                {
                  name: 'models/second',
                  displayName: 'Second',
                  supportedGenerationMethods: ['generateContent'],
                },
              ],
            }
          : {
              models: [
                { name: 'models/first', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
              ],
              nextPageToken: 'next',
            },
      );
    });
    expect((await provider.models(context())).map((model) => model.id)).toEqual(['first', 'second']);
  });
});
import { usageFromGenerationError } from '../../src/ai/usage';
