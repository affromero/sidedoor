import { describe, expect, it } from 'vitest';
import {
  ProviderRegistry,
  type ProviderAdapter,
  type GenerationEvent,
  type GenerationRequest,
  type RegistryOptions,
} from '../../src/ai/index';
import { MetricCollector, type MetricEvent } from '../../src/observability';
import { usageFromGenerationError, GenerationUsageError } from '../../src/ai/usage';
import { createCompatibleProvider } from '../../src/ai/providers/openai-compatible';

const request: GenerationRequest = {
  provider: 'test',
  model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};
function registry(generate: ProviderAdapter['generate'], options: Partial<RegistryOptions> = {}) {
  return new ProviderRegistry({
    credentials: {
      async resolve() {
        return {};
      },
    },
    providers: [
      {
        descriptor: {
          id: 'test',
          label: 'Test',
          transport: 'local',
          fields: [],
          capabilities: ['text'],
          models: [],
        },
        async readiness() {
          return { code: 'ready', checkedAt: 1 };
        },
        async models() {
          return [];
        },
        generate,
      },
    ],
    ...options,
  });
}

describe('provider execution', () => {
  it.each([
    [200, 'valid'],
    [401, 'rejected'],
    [403, 'inconclusive'],
    [429, 'inconclusive'],
    [503, 'inconclusive'],
    [0, 'inconclusive'],
  ])('classifies credential probes without invalidating keys on HTTP %s', async (status, expected) => {
    const provider = createCompatibleProvider({
      descriptor: {
        id: 'probe',
        label: 'Probe',
        transport: 'api',
        fields: [],
        models: [],
        capabilities: ['text'],
      },
      defaultBaseUrl: 'https://api.openai.com/v1',
      requiresKey: true,
      maxRetries: 0,
      fetch: async (input, init) => {
        expect(String(input)).toContain('/models');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-key');
        if (status === 0) throw new TypeError('Network unavailable');
        return Response.json(
          status === 200 ? { object: 'list', data: [] } : { error: { message: 'Probe failed' } },
          {
            status,
          },
        );
      },
    });
    const selected = new ProviderRegistry({
      providers: [provider],
      credentials: {
        async resolve() {
          return { apiKey: 'selected-key' };
        },
      },
    });
    expect(await selected.validateCredentials('probe')).toMatchObject({ status: expected });
  });

  it('keeps missing credentials distinct and preserves caller cancellation', async () => {
    let sent = false;
    const provider = createCompatibleProvider({
      descriptor: {
        id: 'probe',
        label: 'Probe',
        transport: 'api',
        fields: [],
        models: [],
        capabilities: ['text'],
      },
      defaultBaseUrl: 'https://probe.example/v1',
      requiresKey: true,
      fetch: async () => {
        sent = true;
        return Response.json({ data: [] });
      },
    });
    const selected = new ProviderRegistry({
      providers: [provider],
      credentials: {
        async resolve() {
          return {};
        },
      },
    });
    expect(await selected.validateCredentials('probe')).toMatchObject({ status: 'missing' });
    expect(sent).toBe(false);
    const controller = new AbortController();
    const reason = new Error('Caller stopped validation');
    controller.abort(reason);
    await expect(selected.validateCredentials('probe', controller.signal)).rejects.toBe(reason);
    await expect(selected.validateCredentials('unknown')).rejects.toMatchObject({ code: 'unknown_provider' });
  });

  it('rejects provider timing when the adapter does not manage attempt deadlines', async () => {
    const provider = registry(
      async function* () {
        yield { type: 'text', text: 'Must not run' };
      },
      { timeoutMode: 'provider' },
    );
    await expect(provider.generate(request).next()).rejects.toThrow('requires adapter support');
  });
  it('retains terminal measurements that settle during cancellation cleanup', async () => {
    const recorded: MetricEvent[] = [];
    const metrics = new MetricCollector({
      sink: {
        async write(events) {
          recorded.push(...events);
        },
      },
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const provider = registry(
      async function* (request, context): AsyncGenerator<GenerationEvent> {
        expect(request.model).toBe('test-model');
        yield { type: 'text', text: 'partial' };
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => setTimeout(resolve, 10), { once: true });
          ready();
        });
        throw new GenerationUsageError(
          'Generation stopped',
          { inputTokens: 21, outputTokens: 6 },
          { cause: context.signal.reason },
        );
      },
      { metrics },
    );
    const controller = new AbortController();
    const stream = provider.generate({ ...request, signal: controller.signal });
    expect(await stream.next()).toMatchObject({ value: { type: 'text', text: 'partial' } });
    const pending = stream.next().catch((error: unknown) => error);
    await started;
    controller.abort();
    const failure = await pending;
    expect(failure).toBeInstanceOf(Error);
    expect(usageFromGenerationError(failure)).toMatchObject({ inputTokens: 21, outputTokens: 6 });
    await metrics.flush();
    expect(recorded).toEqual([
      expect.objectContaining({ outcome: 'cancelled', inputTokens: 21, outputTokens: 6 }),
    ]);
  });
  it.each([true, false])(
    'records only authoritative failure usage from a compatible stream: %s',
    async (terminalUsage) => {
      const recorded: MetricEvent[] = [];
      const metrics = new MetricCollector({
        sink: {
          async write(events) {
            recorded.push(...events);
          },
        },
      });
      const chunks = terminalUsage
        ? [
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
            { choices: [], usage: { prompt_tokens: 19, completion_tokens: 4 } },
            { choices: [{ delta: { content: 'invalid trailing output' }, finish_reason: null }] },
          ]
        : [
            {
              choices: [{ delta: {}, finish_reason: null }],
              usage: { prompt_tokens: 19, completion_tokens: 4 },
            },
            { choices: [{ delta: { refusal: 'refused' }, finish_reason: null }] },
          ];
      const adapter = createCompatibleProvider({
        descriptor: {
          id: 'test',
          label: 'Test',
          transport: 'api',
          fields: [],
          models: [],
          capabilities: ['text'],
        },
        defaultBaseUrl: 'https://api.example/v1',
        requiresKey: false,
        fetch: async () =>
          new Response(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      });
      const provider = new ProviderRegistry({
        providers: [adapter],
        metrics,
        credentials: {
          async resolve() {
            return {};
          },
        },
      });
      let failure: unknown;
      try {
        for await (const event of provider.generate(request)) expect(event.type).not.toBe('finish');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const expected = { inputTokens: terminalUsage ? 19 : null, outputTokens: terminalUsage ? 4 : null };
      expect(usageFromGenerationError(failure)).toMatchObject(expected);
      await metrics.flush();
      expect(recorded).toEqual([expect.objectContaining({ ...expected, outcome: 'error' })]);
    },
  );
  it('requires vision capability for URL images before opening a text provider', async () => {
    const provider = registry(() => {
      throw new Error('Text provider must not open');
    });
    await expect(
      provider
        .generate({
          ...request,
          messages: [{ role: 'user', content: [{ type: 'image_url', url: 'https://images.example/a.png' }] }],
        })
        .next(),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
  });
  it.each(['return', 'abort'])('does not publish success when %s arrives during cleanup', async (action) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const recorded: MetricEvent[] = [];
    const metrics = new MetricCollector({
      sink: {
        async write(events) {
          recorded.push(...events);
        },
      },
    });
    const provider = registry(
      () => {
        const source = (async function* (): AsyncGenerator<GenerationEvent> {
          yield { type: 'finish', reason: 'complete', usage: { inputTokens: 9, outputTokens: 2 } };
        })();
        source.return = async () => {
          entered();
          await waiting;
          return { done: true, value: undefined };
        };
        return source;
      },
      { metrics },
    );
    const controller = new AbortController();
    const stream = provider.generate({ ...request, signal: controller.signal });
    const pending = stream.next().catch((error: unknown) => error);
    await started;
    const closing = action === 'return' ? stream.return(undefined) : undefined;
    if (action === 'abort') controller.abort();
    finish();
    expect(await pending).toBeInstanceOf(Error);
    if (closing) expect(await closing).toMatchObject({ done: true });
    await metrics.flush();
    expect(recorded).toEqual([
      expect.objectContaining({ outcome: 'cancelled', inputTokens: 9, outputTokens: 2 }),
    ]);
  });
  it('closes while credential resolution is pending without opening the provider', async () => {
    let finish!: (value: Record<string, never>) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const credentials = new Promise<Record<string, never>>((resolve) => {
      finish = resolve;
    });
    const provider = registry(
      () => {
        throw new Error('Provider must not open');
      },
      {
        credentials: {
          resolve() {
            entered();
            return credentials;
          },
        },
      },
    );
    const stream = provider.generate(request);
    const pending = stream.next().catch((error: unknown) => error);
    await started;
    expect(await stream.return(undefined)).toMatchObject({ done: true });
    expect(await pending).toBeInstanceOf(Error);
    finish({});
    await credentials;
  });

  it.each(['return', 'throw'])('interrupts an actual SDK body read through %s', async (action) => {
    let stopped = false;
    const adapter = createCompatibleProvider({
      descriptor: {
        id: 'test',
        label: 'Test',
        transport: 'local',
        fields: [],
        models: [],
        capabilities: ['text'],
      },
      defaultBaseUrl: 'http://localhost:11434/v1',
      requiresKey: false,
      fetch: async (input, init) => {
        expect(String(input)).toContain('/chat/completions');
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"Ready"},"finish_reason":null}]}\n\n',
                ),
              );
              init?.signal?.addEventListener(
                'abort',
                () => {
                  stopped = true;
                  controller.error(init.signal?.reason);
                },
                { once: true },
              );
            },
            cancel() {
              stopped = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const provider = registry(adapter.generate);
    const stream = provider.generate(request);
    expect(await stream.next()).toMatchObject({ value: { type: 'text', text: 'Ready' } });
    const pending = stream.next().catch((error: unknown) => error);
    if (action === 'return') expect(await stream.return(undefined)).toMatchObject({ done: true });
    else {
      const reason = new Error('Caller interruption');
      await expect(stream.throw(reason)).rejects.toBe(reason);
    }
    expect(await pending).toBeInstanceOf(Error);
    expect(stopped).toBe(true);
  });

  it.each(['reject', 'timeout'])(
    'surfaces unconfirmed adapter cleanup (%s) and records one failed metric',
    async (mode) => {
      const recorded: MetricEvent[] = [];
      const metrics = new MetricCollector({
        sink: {
          async write(events) {
            recorded.push(...events);
          },
        },
      });
      const adapter: ProviderAdapter['generate'] = () => {
        const source = (async function* (): AsyncGenerator<GenerationEvent> {
          yield { type: 'finish', reason: 'complete', usage: { inputTokens: 9, outputTokens: 2 } };
        })();
        source.return = async () => {
          if (mode === 'reject') throw new Error('Adapter release failed');
          return new Promise<IteratorResult<GenerationEvent>>(() => {});
        };
        return source;
      };
      const failing = registry(adapter, { metrics });
      const failure = await failing
        .generate(request)
        .next()
        .catch((error: unknown) => error);
      expect((failure as Error).message).toContain('cleanup');
      expect(usageFromGenerationError(failure)).toMatchObject({ inputTokens: 9, outputTokens: 2 });
      expect((failure as Error).cause).toMatchObject({
        code: 'cleanup_failed',
        unconfirmed: mode === 'timeout',
      });
      await metrics.flush();
      expect(recorded).toEqual([
        expect.objectContaining({ outcome: 'error', inputTokens: 9, outputTokens: 2 }),
      ]);
    },
    10000,
  );

  it('preserves cleanup rejection through a pending read and caller return', async () => {
    const cleanup = new Error('Adapter release failed');
    const provider = registry((input, context) => {
      const source = (async function* (): AsyncGenerator<GenerationEvent> {
        yield { type: 'text', text: input.model };
        await new Promise<void>((...callbacks) => {
          context.signal.addEventListener('abort', () => callbacks[1](context.signal.reason), { once: true });
        });
      })();
      source.return = async () => {
        throw cleanup;
      };
      return source;
    });
    const stream = provider.generate(request);
    await stream.next();
    const pending = stream.next().catch((error: unknown) => error);
    const closing = stream.return(undefined).catch((error: unknown) => error);
    const failure = await pending;
    expect(await closing).toBe(failure);
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toEqual([
      expect.any(Error),
      expect.objectContaining({ code: 'cleanup_failed', cause: cleanup }),
    ]);
  });
  it('bounds streamed output by encoded bytes', async () => {
    const provider = registry(async function* () {
      yield { type: 'text', text: 'é' };
      yield { type: 'text', text: 'é' };
      yield { type: 'finish', reason: 'complete' };
    });
    const stream = provider.generate({ ...request, maxOutputBytes: 3 });
    expect((await stream.next()).value).toEqual({ type: 'text', text: 'é' });
    await expect(stream.next()).rejects.toMatchObject({ code: 'invalid_stream' });
  });

  it('includes citation metadata in the output bound', async () => {
    const provider = registry(async function* () {
      yield { type: 'citation', url: 'https://example.com', title: 'x'.repeat(200), start: 0, end: 1 };
      yield { type: 'finish', reason: 'complete' };
    });
    await expect(provider.generate({ ...request, maxOutputBytes: 100 }).next()).rejects.toMatchObject({
      code: 'invalid_stream',
    });
  });
  it('streams text and a single terminal outcome from the selected backend', async () => {
    const provider = registry(async function* () {
      yield { type: 'text', text: 'answer' };
      yield { type: 'finish', reason: 'complete' };
    });
    const events: GenerationEvent[] = [];
    for await (const event of provider.generate(request)) events.push(event);
    expect(events).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'finish', reason: 'complete' },
    ]);
  });

  it('rejects a backend ending without an explicit completion', async () => {
    const provider = registry(async function* () {
      yield { type: 'text', text: 'partial' };
    });
    const consume = async () => {
      for await (const event of provider.generate(request)) expect(event.type).toBe('text');
    };
    await expect(consume()).rejects.toMatchObject({ code: 'invalid_stream' });
  });

  it('aborts the provider when the caller stops consuming output', async () => {
    let signal: AbortSignal | undefined;
    const provider = registry(async function* (input, context) {
      signal = context.signal;
      yield { type: 'text', text: input.model };
      yield { type: 'finish', reason: 'complete' };
    });
    for await (const event of provider.generate(request)) {
      expect(event.type).toBe('text');
      break;
    }
    expect(signal?.aborted).toBe(true);
  });

  it('rejects unsupported requirements before sending a request', async () => {
    const provider = registry(() => {
      throw new Error('Backend must not run');
    });
    await expect(provider.generate({ ...request, required: ['vision'] }).next()).rejects.toMatchObject({
      code: 'unsupported_capability',
    });
  });
});
