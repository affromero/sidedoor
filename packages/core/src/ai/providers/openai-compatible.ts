import { providerConnection } from '../configuration/connection';
import OpenAI from 'openai';
import { z } from 'zod';
import { providerFetch } from './http';
import { modelCredentialProbe } from '../../providers/model-credential-proof';
import { GenerationUsageError } from '../usage';
import type {
  ChatCompletionMessageParam,
  ChatCompletionContentPart,
  ChatCompletionAssistantMessageParam,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions/completions';
import {
  ProviderError,
  MissingProviderCredentialsError,
  imageUrl,
  responseSchemaName,
  validateTemperature,
  type GenerationEvent,
  type GenerationRequest,
  type Message,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderDescriptor,
  type TokenUsage,
} from '../index';

export interface CompatibleProviderOptions {
  descriptor: ProviderDescriptor;
  defaultBaseUrl: string;
  requiresKey: boolean;
  normalizeV1?: boolean;
  maxTokensParameter?: 'max_tokens' | 'max_completion_tokens';
  streaming?: boolean;
  maxRetries?: number;
  /** Permit compatible endpoints that accept image parts in assistant history. */
  assistantImages?: boolean;
  fetch?: typeof fetch;
}
const effortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const argumentsSchema = z.record(z.string(), z.unknown());

async function* completionChunk(response: ChatCompletion): AsyncGenerator<ChatCompletionChunk> {
  yield {
    id: response.id,
    object: 'chat.completion.chunk',
    created: response.created,
    model: response.model,
    usage: response.usage,
    choices: [],
  };
  yield {
    id: response.id,
    object: 'chat.completion.chunk',
    created: response.created,
    model: response.model,
    choices: response.choices.map((choice) => ({
      index: choice.index,
      finish_reason: choice.finish_reason,
      logprobs: choice.logprobs,
      delta: {
        content: choice.message.content,
        refusal: choice.message.refusal,
        tool_calls: choice.message.tool_calls?.map((call, index) => {
          if (call.type !== 'function')
            throw new ProviderError('invalid_stream', 'Unsupported tool call type');
          return { ...call, index };
        }),
      },
    })),
  };
}

function text(message: Message): string {
  if (message.content.some((part) => part.type !== 'text'))
    throw new ProviderError('invalid_request', 'This message role accepts text only');
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

function messages(request: GenerationRequest, assistantImages = false): ChatCompletionMessageParam[] {
  return request.messages.map((message): ChatCompletionMessageParam => {
    if (message.role === 'tool') {
      if (!message.toolCallId)
        throw new ProviderError('invalid_request', 'A tool result must identify its call');
      return { role: 'tool', tool_call_id: message.toolCallId, content: text(message) };
    }
    if (message.role === 'system') return { role: 'system', content: text(message) };
    if (message.role === 'assistant' && message.content.every((part) => part.type === 'text')) {
      const result: ChatCompletionAssistantMessageParam = { role: 'assistant', content: text(message) };
      if (message.toolCalls?.length)
        result.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }));
      return result;
    }
    const content: ChatCompletionContentPart[] = message.content.map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'image_url') return { type: 'image_url', image_url: { url: imageUrl(part.url) } };
      if (part.type === 'image')
        return {
          type: 'image_url',
          image_url: { url: `data:${part.mediaType};base64,${Buffer.from(part.data).toString('base64')}` },
        };
      throw new ProviderError('unsupported_capability', 'This provider does not accept audio input');
    });
    if (message.role === 'assistant') {
      if (!assistantImages)
        throw new ProviderError(
          'unsupported_capability',
          'This transport does not accept images in assistant history',
        );
      // Compatible endpoints may extend the official SDK's text-only assistant schema.
      return {
        role: 'assistant',
        content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      } as unknown as ChatCompletionAssistantMessageParam;
    }
    return {
      role: 'user',
      content: message.content.every((part) => part.type === 'text') ? text(message) : content,
    };
  });
}

/** Official and local Chat Completions transports share this adapter; endpoints never fail over. */
export function createCompatibleProvider(options: CompatibleProviderOptions): ProviderAdapter {
  function client(context: ProviderContext, probeFetch?: typeof fetch): OpenAI {
    const { baseUrl, apiKey } = providerConnection(context.credentials, {
      defaultBaseUrl: options.defaultBaseUrl,
      normalizeV1: options.normalizeV1,
      requiresKey: options.requiresKey,
      allowAnonymous: true,
    });
    return new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || 'unused',
      maxRetries: options.maxRetries ?? 2,
      fetch: providerFetch(context, probeFetch ?? options.fetch),
    });
  }
  return {
    descriptor: options.descriptor,
    validateConfiguration(context) {
      client(context);
    },
    async readiness(context) {
      try {
        const probe = modelCredentialProbe(context.signal, options.fetch);
        const response = await client(context, probe.fetch)
          .models.list({ signal: context.signal })
          .asResponse();
        return await probe.readiness(response);
      } catch (error) {
        context.signal.throwIfAborted();
        if (error instanceof MissingProviderCredentialsError)
          return { code: 'missing_credentials', checkedAt: Date.now(), action: 'configure' };
        if (error instanceof ProviderError)
          return { code: 'not_configured', checkedAt: Date.now(), action: 'configure' };
        if (error instanceof OpenAI.AuthenticationError)
          return { code: 'not_authenticated', checkedAt: Date.now(), action: 'configure' };
        return { code: 'unreachable', checkedAt: Date.now(), action: 'retry' };
      }
    },
    async models(context) {
      if (options.descriptor.id === 'ollama') {
        const connection = providerConnection(context.credentials, {
          defaultBaseUrl: options.defaultBaseUrl,
          normalizeV1: true,
          requiresKey: false,
          allowAnonymous: true,
        });
        const url = connection.baseUrl.replace(/\/v1$/, '') + '/api/tags';
        const response = await providerFetch(context, options.fetch)(url, {
          signal: context.signal,
          headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
        });
        if (!response.ok) throw new Error('Model discovery failed');
        const data = z
          .object({ models: z.array(z.object({ name: z.string().min(1) })).max(10_000) })
          .parse(await response.json());
        return data.models.map((model) => ({
          id: model.name,
          label: model.name,
          capabilities: options.descriptor.capabilities,
        }));
      }
      const page = await client(context).models.list({ signal: context.signal });
      const result = [];
      for await (const model of page) {
        context.signal.throwIfAborted();
        if (result.length >= 10_000)
          throw new ProviderError('invalid_stream', 'Model list exceeded the allowed size');
        result.push({
          id: model.id,
          label: model.id,
          capabilities: options.descriptor.capabilities,
        });
      }
      return result;
    },
    async *generate(request, context): AsyncGenerator<GenerationEvent> {
      if (request.webSearch !== undefined)
        throw new ProviderError(
          'unsupported_capability',
          'This transport does not support web search settings',
        );
      if (request.allowWeb)
        throw new ProviderError(
          'unsupported_capability',
          'Web search requires the shared tool runtime for this transport',
        );
      const parameters: ChatCompletionCreateParamsNonStreaming = {
        model: request.model,
        temperature: validateTemperature(request.temperature),
        messages: messages(request, options.assistantImages),
        ...(request.maxOutputTokens === undefined
          ? {}
          : options.maxTokensParameter === 'max_tokens'
            ? { max_tokens: request.maxOutputTokens }
            : { max_completion_tokens: request.maxOutputTokens }),
        ...(request.effort ? { reasoning_effort: effortSchema.parse(request.effort) } : {}),
        ...(request.schema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: responseSchemaName(request.schemaName),
                  schema: request.schema,
                  strict: true,
                },
              },
            }
          : request.responseFormat
            ? { response_format: { type: request.responseFormat } }
            : {}),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.schema },
              })),
            }
          : {}),
      };
      const stream =
        options.streaming === false
          ? completionChunk(
              await client(context).chat.completions.create(parameters, { signal: context.signal }),
            )
          : await client(context).chat.completions.create(
              { ...parameters, stream: true, stream_options: { include_usage: true } },
              { signal: context.signal },
            );
      let reason: 'complete' | 'length' | 'tool_calls' | undefined;
      let usage: TokenUsage = { inputTokens: null, outputTokens: null };
      let authoritativeUsage: TokenUsage | undefined;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      try {
        for await (const chunk of stream) {
          if (chunk.usage)
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              ...(chunk.usage.prompt_tokens_details
                ? { cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens ?? null }
                : {}),
              ...(chunk.usage.completion_tokens_details
                ? { reasoningTokens: chunk.usage.completion_tokens_details.reasoning_tokens ?? null }
                : {}),
            };
          if (chunk.usage && (options.streaming === false || (reason && chunk.choices.length === 0))) {
            if (authoritativeUsage)
              throw new ProviderError('invalid_stream', 'Provider emitted multiple terminal usage records');
            authoritativeUsage = { ...usage };
          }
          const choice = chunk.choices[0];
          if (!choice) continue;
          if (reason)
            throw new ProviderError('invalid_stream', 'Provider emitted choice data after completion');
          if (choice.delta.refusal)
            throw new ProviderError('invalid_stream', 'The provider refused the request');
          if (choice.delta.content) yield { type: 'text', text: choice.delta.content };
          for (const delta of choice.delta.tool_calls ?? []) {
            const current = calls.get(delta.index) ?? { id: '', name: '', arguments: '' };
            current.id += delta.id ?? '';
            current.name += delta.function?.name ?? '';
            current.arguments += delta.function?.arguments ?? '';
            if (current.arguments.length > 1024 * 1024 || calls.size > 100)
              throw new ProviderError('invalid_stream', 'Tool call output exceeds the allowed size');
            calls.set(delta.index, current);
          }
          if (choice.finish_reason === 'content_filter')
            throw new ProviderError('invalid_stream', 'The provider filtered its response');
          if (choice.finish_reason)
            reason =
              choice.finish_reason === 'length'
                ? 'length'
                : choice.finish_reason === 'tool_calls'
                  ? 'tool_calls'
                  : 'complete';
        }
        if (!reason) throw new ProviderError('invalid_stream', 'Provider ended without a completion reason');
        for (const call of calls.values()) {
          if (!call.id || !call.name) throw new ProviderError('invalid_stream', 'Incomplete tool call');
          yield {
            type: 'tool_call',
            id: call.id,
            name: call.name,
            arguments: argumentsSchema.parse(JSON.parse(call.arguments)),
          };
        }
        yield { type: 'finish', reason, usage };
      } catch (error) {
        if (authoritativeUsage)
          throw new GenerationUsageError(
            error instanceof Error ? error.message : 'Provider generation failed',
            authoritativeUsage,
            { cause: error },
          );
        throw error;
      }
    },
  };
}
