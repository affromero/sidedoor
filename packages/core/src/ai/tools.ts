import { randomUUID } from 'node:crypto';
import { abortable } from '../runtime/abort';
import { interruptibleStream } from '../runtime/stream';
import {
  ProviderError,
  ProviderRegistry,
  ProviderCleanupError,
  type GenerationEvent,
  type GenerationRequest,
  type Message,
  type TokenUsage,
  type ToolDefinition,
} from './index';

export interface ToolContext<Actor> {
  actor: Actor;
  signal: AbortSignal;
  operationId: string;
}
interface PreparedTool {
  effect: 'read' | 'write';
  authorize(): Promise<void>;
  execute(): Promise<string>;
}
export interface RuntimeTool<Actor> extends ToolDefinition {
  prepare(input: Record<string, unknown>, context: ToolContext<Actor>): PreparedTool;
}
export function defineTool<Input, Actor>(
  definition: ToolDefinition & {
    effect: 'read' | 'write';
    parse(input: unknown): Input;
    authorize(input: Input, context: ToolContext<Actor>): Promise<void>;
    execute(input: Input, context: ToolContext<Actor>): Promise<string>;
  },
): RuntimeTool<Actor> {
  return {
    name: definition.name,
    description: definition.description,
    schema: definition.schema,
    prepare(input, context) {
      const parsed = definition.parse(input);
      return {
        effect: definition.effect,
        authorize: () => definition.authorize(parsed, context),
        execute: () => definition.execute(parsed, context),
      };
    },
  };
}
export class ToolExecutionError extends Error {
  constructor(
    public readonly code:
      | 'unknown_tool'
      | 'invalid_calls'
      | 'tool_limit'
      | 'tool_failed'
      | 'outcome_unknown'
      | 'completed_result_too_large',
    public readonly callId?: string,
    options?: ErrorOptions,
  ) {
    super(`Agent tool ${code}`, options);
  }
}
export interface ToolRuntimeOptions<Actor> {
  registry: ProviderRegistry;
  tools: readonly RuntimeTool<Actor>[];
  maxToolRounds?: number;
  maxCalls?: number;
  toolTimeoutMs?: number;
  maxArgumentBytes?: number;
  maxResultBytes?: number;
  finalAnswerOnLimit?: boolean;
  structuredFinalAnswer?: boolean;
}
export type ToolRuntimeEvent =
  | GenerationEvent
  | { type: 'tool_status'; callId: string; name: string; status: 'running' | 'complete' }
  | { type: 'tool_limit'; limit: 'rounds' | 'calls' };
const usageFields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;

/** Sequential tools preserve side-effect order. There are no automatic tool retries. */
export class ToolRuntime<Actor> {
  private readonly tools = new Map<string, RuntimeTool<Actor>>();
  private readonly rounds: number;
  private readonly calls: number;
  private readonly timeout: number;
  private readonly argumentBytes: number;
  private readonly resultBytes: number;
  constructor(private readonly options: ToolRuntimeOptions<Actor>) {
    this.rounds = options.maxToolRounds ?? 6;
    this.calls = options.maxCalls ?? 24;
    this.timeout = options.toolTimeoutMs ?? 30_000;
    this.argumentBytes = options.maxArgumentBytes ?? 64_000;
    this.resultBytes = options.maxResultBytes ?? 1_000_000;
    if (
      ![this.rounds, this.calls, this.timeout, this.argumentBytes, this.resultBytes].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new Error('Tool limits must be positive integers');
    for (const tool of options.tools) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || this.tools.has(tool.name))
        throw new Error('Invalid or duplicate tool name');
      this.tools.set(tool.name, tool);
    }
  }

  stream(request: GenerationRequest, actor: Actor): AsyncGenerator<ToolRuntimeEvent> {
    return interruptibleStream((signal) => this.run({ ...request, signal }, actor), {
      signal: request.signal,
      isCleanupError: (error) => error instanceof ProviderCleanupError,
    });
  }

  private async *run(request: GenerationRequest, actor: Actor): AsyncGenerator<ToolRuntimeEvent> {
    if (
      ![request.consumerId, request.conversationId, request.credentialOwnerId].every((value) =>
        Boolean(value?.trim()),
      )
    )
      throw new ProviderError(
        'invalid_request',
        'Tool execution requires server-derived caller, conversation and credential owner identities',
      );
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(request.timeoutMs ?? 600_000),
      ...(request.signal ? [request.signal] : []),
    ]);
    const operationId = randomUUID();
    const seen = new Set<string>();
    const totals: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const instructions = request.messages.filter((message) => message.role === 'system');
    let history = [...request.messages];
    let continuation = request.continuation;
    const structuredFinal =
      this.options.structuredFinalAnswer && Boolean(request.responseFormat || request.schema);
    let finalize = false;
    try {
      for (let round = 0; round <= this.rounds + (structuredFinal ? 1 : 0); round++) {
        signal.throwIfAborted();
        const calls: Extract<GenerationEvent, { type: 'tool_call' }>[] = [];
        let finish: Extract<GenerationEvent, { type: 'finish' }> | undefined;
        let usage: TokenUsage | undefined;
        let text = '';
        let nextContinuation: typeof continuation;
        const limitReached =
          this.options.finalAnswerOnLimit && (round === this.rounds || seen.size >= this.calls);
        const finalAnswer = finalize || limitReached;
        if (limitReached && !finalize)
          yield { type: 'tool_limit', limit: round === this.rounds ? 'rounds' : 'calls' };
        for await (const event of this.options.registry.generate({
          ...request,
          messages: history,
          continuation,
          signal,
          responseFormat: structuredFinal && !finalAnswer ? undefined : request.responseFormat,
          schema: structuredFinal && !finalAnswer ? undefined : request.schema,
          tools: finalAnswer
            ? undefined
            : [...this.tools.values()].map(({ name, description, schema }) => ({
                name,
                description,
                schema,
              })),
        })) {
          if (event.type === 'finish') {
            finish = event;
            usage = event.usage ?? usage;
            continue;
          }
          if (event.type === 'usage') {
            usage = event.usage;
            continue;
          }
          if (event.type === 'tool_call') {
            if (finalAnswer) throw new ToolExecutionError('invalid_calls', event.id);
            if (seen.size + calls.length >= this.calls) throw new ToolExecutionError('tool_limit');
            calls.push(event);
            continue;
          }
          if (event.type === 'continuation') {
            nextContinuation = event;
            continue;
          }
          if (event.type === 'text') text += event.text;
          if (structuredFinal && !finalAnswer && event.type === 'text') continue;
          yield event;
        }
        if (!finish) throw new ProviderError('invalid_stream', 'Missing round completion');
        for (const field of usageFields) {
          const measurement = usage?.[field];
          totals[field] =
            totals[field] === null || measurement == null ? null : (totals[field] ?? 0) + measurement;
        }
        if (finish.reason !== 'tool_calls') {
          if (calls.length) throw new ToolExecutionError('invalid_calls');
          if (structuredFinal && !finalAnswer) {
            if (finish.reason !== 'complete')
              throw new ProviderError('invalid_stream', 'Provider truncated the tool-planning response');
            finalize = true;
            continue;
          }
          if (nextContinuation) yield { type: 'continuation', ...nextContinuation };
          yield { type: 'finish', reason: finish.reason, usage: totals };
          return;
        }
        if (!calls.length) throw new ToolExecutionError('invalid_calls');
        if (round === this.rounds || seen.size + calls.length > this.calls)
          throw new ToolExecutionError('tool_limit');
        const prepared = calls.map((call) => {
          if (
            !call.id ||
            call.id.length > 256 ||
            seen.has(call.id) ||
            Buffer.byteLength(JSON.stringify(call.arguments)) > this.argumentBytes
          )
            throw new ToolExecutionError('invalid_calls', call.id);
          seen.add(call.id);
          const tool = this.tools.get(call.name);
          if (!tool) throw new ToolExecutionError('unknown_tool', call.id);
          const context = {
            actor,
            signal,
            operationId: `${operationId}:${call.id}`,
          };
          const operation = tool.prepare(call.arguments, context);
          return { call, operation, context };
        });
        // Validate and authorize the entire batch before the first execution.
        for (const item of prepared) await abortable(item.operation.authorize(), signal);
        const results: Message[] = [];
        for (const item of prepared) {
          signal.throwIfAborted();
          yield { type: 'tool_status', callId: item.call.id, name: item.call.name, status: 'running' };
          signal.throwIfAborted();
          item.context.signal = AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]);
          // Recheck permissions after preceding effects and consumer pauses.
          await abortable(item.operation.authorize(), item.context.signal);
          item.context.signal.throwIfAborted();
          let result: string;
          try {
            result = await abortable(item.operation.execute(), item.context.signal);
          } catch (error) {
            throw new ToolExecutionError(
              item.operation.effect === 'write' ? 'outcome_unknown' : 'tool_failed',
              item.call.id,
              { cause: error },
            );
          }
          item.context.signal.throwIfAborted();
          if (Buffer.byteLength(result) > this.resultBytes)
            throw new ToolExecutionError('completed_result_too_large', item.call.id);
          results.push({ role: 'tool', toolCallId: item.call.id, content: [{ type: 'text', text: result }] });
          yield { type: 'tool_status', callId: item.call.id, name: item.call.name, status: 'complete' };
        }
        if (nextContinuation) {
          continuation = nextContinuation;
          history = [...instructions, ...results];
        } else {
          if (continuation) throw new ProviderError('invalid_stream', 'Provider lost its continuation state');
          history.push(
            {
              role: 'assistant',
              content: text ? [{ type: 'text', text }] : [],
              toolCalls: calls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
            },
            ...results,
          );
        }
      }
    } finally {
      controller.abort();
    }
  }
}
