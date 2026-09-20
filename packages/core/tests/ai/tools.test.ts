import { describe, expect, it } from 'vitest';
import {
  ProviderRegistry,
  type GenerationEvent,
  type GenerationRequest,
  type ProviderAdapter,
} from '../../src/ai/index';
import { defineTool, ToolRuntime } from '../../src/ai/tools';
import type { RuntimeTool } from '../../src/ai/tools';

const request: GenerationRequest = {
  provider: 'test',
  model: 'model',
  consumerId: 'owner',
  conversationId: 'conversation',
  credentialOwnerId: 'owner',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'save' }] }],
};
const call: GenerationEvent = {
  type: 'tool_call',
  id: 'save-1',
  name: 'save',
  arguments: { value: 'saved' },
};
function registry(generate: ProviderAdapter['generate']) {
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
          capabilities: ['text', 'tools', 'structured'],
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
  });
}
async function collect<T>(stream: AsyncIterable<T>) {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
function saveTool(values: string[]) {
  return defineTool<string, string>({
    name: 'save',
    description: 'Save a value',
    schema: { type: 'object' },
    effect: 'write',
    parse(input) {
      if (!input || typeof input !== 'object' || !('value' in input) || typeof input.value !== 'string')
        throw new Error('Invalid value');
      return input.value;
    },
    async authorize(value, context) {
      if (context.actor !== 'owner' || value === 'forbidden') throw new Error('Forbidden');
    },
    async execute(value) {
      values.push(value);
      return 'Saved';
    },
  });
}

describe('tool execution', () => {
  it.each(['authorization', 'execution'])(
    'closes during pending tool %s without claiming rollback',
    async (stage) => {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const writes: string[] = [];
      let signal: AbortSignal | undefined;
      const tool: RuntimeTool<string> = {
        name: 'save',
        description: 'Save a value',
        schema: { type: 'object' },
        prepare(input, context) {
          expect(input).toMatchObject({ value: 'saved' });
          signal = context.signal;
          return {
            effect: 'write',
            async authorize() {
              if (stage === 'authorization') {
                entered();
                await waiting;
              }
            },
            async execute() {
              entered();
              await waiting;
              writes.push('saved');
              return 'Saved';
            },
          };
        },
      };
      const runtime = new ToolRuntime({
        registry: registry(async function* () {
          yield call;
          yield { type: 'finish', reason: 'tool_calls' };
        }),
        tools: [tool],
      });
      const stream = runtime.stream(request, 'owner');
      let pending = stream.next().catch((error: unknown) => error);
      if (stage === 'execution') {
        expect(await pending).toMatchObject({ value: { type: 'tool_status', status: 'running' } });
        pending = stream.next().catch((error: unknown) => error);
      }
      await started;
      expect(await stream.return(undefined)).toMatchObject({ done: true });
      const failure = await pending;
      if (stage === 'execution') expect(failure).toMatchObject({ code: 'outcome_unknown' });
      else expect(failure).toBeInstanceOf(Error);
      expect(signal?.aborted).toBe(true);
      expect(writes).toEqual([]);
      finish();
      await waiting;
      expect(writes).toEqual(stage === 'execution' ? ['saved'] : []);
    },
  );
  it('surfaces a truncated planning response without issuing a structured finalization request', async () => {
    const requests: GenerationRequest[] = [];
    const runtime = new ToolRuntime({
      structuredFinalAnswer: true,
      tools: [saveTool([])],
      registry: registry(async function* (input) {
        requests.push(input);
        yield { type: 'text', text: 'Incomplete draft' };
        yield { type: 'finish', reason: 'length' };
      }),
    });
    await expect(
      collect(runtime.stream({ ...request, responseFormat: 'json_object' }, 'owner')),
    ).rejects.toThrow('truncated');
    expect(requests).toHaveLength(1);
  });
  it('withholds preliminary prose and applies JSON formatting only to a final tool-free request', async () => {
    const requests: GenerationRequest[] = [];
    const runtime = new ToolRuntime({
      structuredFinalAnswer: true,
      tools: [saveTool([])],
      registry: registry(async function* (input) {
        requests.push(input);
        yield { type: 'text', text: input.tools ? 'discarded draft' : '{"result":"final"}' };
        yield { type: 'finish', reason: 'complete', usage: { inputTokens: 2, outputTokens: 3 } };
      }),
    });
    const events = await collect(runtime.stream({ ...request, responseFormat: 'json_object' }, 'owner'));
    expect(requests).toHaveLength(2);
    expect(requests[0]!.responseFormat).toBeUndefined();
    expect(requests[1]!.responseFormat).toBe('json_object');
    expect(requests[1]!.tools).toBeUndefined();
    expect(requests[1]!.messages).toEqual(request.messages);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: '{"result":"final"}' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'finish', usage: { inputTokens: 4, outputTokens: 6 } });
  });
  it('can request a final answer without tools after the explicit round budget', async () => {
    const values: string[] = [];
    const runtime = new ToolRuntime({
      maxToolRounds: 1,
      finalAnswerOnLimit: true,
      tools: [saveTool(values)],
      registry: registry(async function* (input) {
        if (input.tools?.length) {
          yield call;
          yield { type: 'finish', reason: 'tool_calls' };
          return;
        }
        expect(input.messages).toContainEqual({
          role: 'tool',
          toolCallId: 'save-1',
          content: [{ type: 'text', text: 'Saved' }],
        });
        yield { type: 'text', text: 'Final answer from available results' };
        yield { type: 'finish', reason: 'complete' };
      }),
    });
    const events = await collect(runtime.stream(request, 'owner'));
    expect(values).toEqual(['saved']);
    expect(events).toContainEqual({ type: 'tool_limit', limit: 'rounds' });
    expect(events).toContainEqual({ type: 'text', text: 'Final answer from available results' });
  });
  it('distinguishes a completed write with an oversized result from an unexecuted tool', async () => {
    const values: string[] = [];
    const runtime = new ToolRuntime({
      maxResultBytes: 2,
      tools: [saveTool(values)],
      registry: registry(async function* () {
        yield call;
        yield { type: 'finish', reason: 'tool_calls' };
      }),
    });
    await expect(collect(runtime.stream(request, 'owner'))).rejects.toMatchObject({
      code: 'completed_result_too_large',
      callId: 'save-1',
    });
    expect(values).toEqual(['saved']);
  });
  it('resumes sealed provider state with only new tool results and keeps private transcripts out of events', async () => {
    const values: string[] = [];
    const runtime = new ToolRuntime({
      tools: [saveTool(values)],
      registry: registry(async function* (input) {
        if (input.continuation) {
          expect(input.continuation.data).toEqual({ privateTranscript: 'private reasoning' });
          expect(input.messages).toEqual([
            { role: 'tool', toolCallId: 'save-1', content: [{ type: 'text', text: 'Saved' }] },
          ]);
          yield { type: 'text', text: 'Done' };
          yield { type: 'finish', reason: 'complete' };
          return;
        }
        yield call;
        yield {
          type: 'continuation',
          provider: input.provider,
          model: input.model,
          data: { privateTranscript: 'private reasoning' },
        };
        yield { type: 'finish', reason: 'tool_calls' };
      }),
    });
    const events = await collect(
      runtime.stream(
        { ...request, consumerId: 'owner', conversationId: 'conversation', credentialOwnerId: 'owner' },
        'owner',
      ),
    );
    expect(values).toEqual(['saved']);
    expect(events).toContainEqual({ type: 'text', text: 'Done' });
    expect(JSON.stringify(events)).not.toContain('private reasoning');
  });
  it('does not start a write when cancelled while the consumer pauses at tool status', async () => {
    const values: string[] = [];
    const controller = new AbortController();
    const runtime = new ToolRuntime({
      tools: [saveTool(values)],
      registry: registry(async function* () {
        yield call;
        yield { type: 'finish', reason: 'tool_calls' };
      }),
    });
    const stream = runtime.stream({ ...request, signal: controller.signal }, 'owner');
    expect((await stream.next()).value).toMatchObject({ type: 'tool_status', status: 'running' });
    controller.abort();
    await expect(stream.next()).rejects.toThrow();
    expect(values).toEqual([]);
  });
  it('feeds authorized results into the next turn and reports usage once', async () => {
    const values: string[] = [];
    const runtime = new ToolRuntime({
      tools: [saveTool(values)],
      registry: registry(async function* (input) {
        if (input.messages.some((message) => message.role === 'tool')) {
          expect(input.messages.at(-1)).toEqual({
            role: 'tool',
            toolCallId: 'save-1',
            content: [{ type: 'text', text: 'Saved' }],
          });
          yield { type: 'text', text: 'Done' };
          yield { type: 'finish', reason: 'complete', usage: { inputTokens: 5, outputTokens: 2 } };
          return;
        }
        yield call;
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } };
        yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 3, outputTokens: 1 } };
      }),
    });
    const events = await collect(runtime.stream(request, 'owner'));
    expect(values).toEqual(['saved']);
    expect(events.filter((event) => event.type === 'finish')).toEqual([
      {
        type: 'finish',
        reason: 'complete',
        usage: {
          inputTokens: 8,
          outputTokens: 3,
          cachedInputTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
        },
      },
    ]);
    expect(events).toContainEqual({ type: 'text', text: 'Done' });
  });

  it.each(['duplicate', 'unknown', 'invalid', 'unauthorized'] as const)(
    'rejects a %s batch before any effect',
    async (failure) => {
      const values: string[] = [];
      const runtime = new ToolRuntime({
        tools: [saveTool(values)],
        registry: registry(async function* () {
          yield call;
          yield {
            type: 'tool_call',
            id: failure === 'duplicate' ? 'save-1' : 'save-2',
            name: failure === 'unknown' ? 'missing' : 'save',
            arguments:
              failure === 'invalid' ? {} : { value: failure === 'unauthorized' ? 'forbidden' : 'second' },
          };
          yield { type: 'finish', reason: 'tool_calls' };
        }),
      });
      await expect(collect(runtime.stream(request, 'owner'))).rejects.toThrow();
      expect(values).toEqual([]);
    },
  );

  it.each(['truncated', 'failed', 'length'] as const)(
    'does not execute a tool from a %s round',
    async (failure) => {
      const values: string[] = [];
      const runtime = new ToolRuntime({
        tools: [saveTool(values)],
        registry: registry(async function* () {
          yield call;
          if (failure === 'failed') throw new Error('Backend failed');
          if (failure === 'length') yield { type: 'finish', reason: 'length' };
        }),
      });
      await expect(collect(runtime.stream(request, 'owner'))).rejects.toThrow();
      expect(values).toEqual([]);
    },
  );

  it('reports an interrupted write as an unknown outcome without retrying it', async () => {
    const operations: string[] = [];
    const runtime = new ToolRuntime({
      toolTimeoutMs: 15,
      tools: [
        defineTool({
          name: 'save',
          description: 'Save',
          schema: {},
          effect: 'write',
          parse: () => undefined,
          async authorize() {},
          async execute(value, context) {
            operations.push(context.operationId);
            await new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
            context.signal.throwIfAborted();
            return 'Saved';
          },
        }),
      ],
      registry: registry(async function* () {
        yield call;
        yield { type: 'finish', reason: 'tool_calls' };
      }),
    });
    await expect(collect(runtime.stream(request, 'owner'))).rejects.toMatchObject({
      code: 'outcome_unknown',
      callId: 'save-1',
    });
    expect(operations).toHaveLength(1);
  });
});
