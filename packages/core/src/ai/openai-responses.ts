import OpenAI from 'openai';
import { z } from 'zod';
import { providerFetch } from './http';
import { modelCredentialProbe } from '../providers/model-credential-proof';
import { providerConnection } from './connection';
import { GenerationUsageError } from './usage';
import type {
  Response as OpenAIResponse,
  ResponseStreamEvent,
  ResponseInput,
  ResponseInputContent,
  Tool,
} from 'openai/resources/responses/responses';
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
} from './index';

export interface ResponsesProviderOptions {
  defaultBaseUrl?: string;
  webSearchType?: 'web_search' | 'web_search_preview';
  descriptor: ProviderDescriptor;
  fetch?: typeof fetch;
  maxRetries?: number;
  streaming?: boolean;
}

function responseUsage(response: OpenAIResponse): TokenUsage {
  return {
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
    cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? null,
    reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? null,
  };
}

async function* responseEvents(
  value: OpenAIResponse | AsyncIterable<ResponseStreamEvent>,
): AsyncGenerator<ResponseStreamEvent> {
  if (Symbol.asyncIterator in value) {
    yield* value;
    return;
  }
  if (!['completed', 'incomplete', 'failed'].includes(value.status ?? ''))
    throw new ProviderError('invalid_stream', 'Provider ended without a completed response');
  const blocks = value.output.flatMap((item) => (item.type === 'message' ? item.content : []));
  if (blocks.some((block) => block.type === 'refusal'))
    throw new ProviderError('invalid_stream', 'The provider refused the request');
  const outputText = blocks.map((block) => (block.type === 'output_text' ? block.text : '')).join('');
  if (outputText)
    yield {
      type: 'response.output_text.delta',
      delta: outputText,
      item_id: value.id,
      output_index: 0,
      content_index: 0,
      sequence_number: 0,
      logprobs: [],
    };
  if (value.status === 'failed') yield { type: 'response.failed', response: value, sequence_number: 1 };
  else if (value.status === 'incomplete')
    yield { type: 'response.incomplete', response: value, sequence_number: 1 };
  else yield { type: 'response.completed', response: value, sequence_number: 1 };
}
const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const argumentsSchema = z.record(z.string(), z.unknown());
// Transcript entries are SDK response objects. The upstream API validates each input-item schema.
const transcriptSchema = z.array(z.object({ type: z.string() }).passthrough()).max(1000);

function text(message: Message): string {
  if (message.content.some((part) => part.type !== 'text'))
    throw new ProviderError('invalid_request', 'This message role accepts text only');
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}
function input(request: GenerationRequest): ResponseInput {
  const result: ResponseInput = [];
  if (request.continuation) {
    if (request.continuation.provider !== request.provider || request.continuation.model !== request.model)
      throw new ProviderError('invalid_request', 'Continuation belongs to a different provider or model');
    result.push(...(transcriptSchema.parse(request.continuation.data) as ResponseInput));
  }
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      if (!message.toolCallId)
        throw new ProviderError('invalid_request', 'A tool result must identify its call');
      result.push({ type: 'function_call_output', call_id: message.toolCallId, output: text(message) });
      continue;
    }
    const content: ResponseInputContent[] = message.content.map((part) => {
      if (part.type === 'text') return { type: 'input_text', text: part.text };
      if (part.type === 'image_url')
        return { type: 'input_image', detail: 'auto', image_url: imageUrl(part.url) };
      if (part.type === 'image')
        return {
          type: 'input_image',
          detail: 'auto',
          image_url: `data:${part.mediaType};base64,${Buffer.from(part.data).toString('base64')}`,
        };
      throw new ProviderError('unsupported_capability', 'This Responses adapter does not accept audio input');
    });
    if (message.content.length)
      result.push({
        type: 'message',
        role: message.role,
        content:
          message.role === 'assistant' && message.content.every((part) => part.type === 'text')
            ? text(message)
            : content,
      });
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? [])
        result.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
  }
  return result;
}

/** Explicit Responses transport. Provider-side storage is disabled; continuation stays with the application. */
export function createResponsesProvider(options: ResponsesProviderOptions): ProviderAdapter {
  const endpointOptions = {
    defaultBaseUrl: options.defaultBaseUrl ?? 'https://api.openai.com/v1',
    requiresKey: true,
  };
  const baseURL = providerConnection({ apiKey: 'validation' }, endpointOptions).baseUrl;
  const webSearchType = z
    .enum(['web_search', 'web_search_preview'])
    .parse(options.webSearchType ?? 'web_search');
  function client(context: ProviderContext, probeFetch?: typeof fetch) {
    const apiKey = context.credentials.apiKey;
    if (typeof apiKey !== 'string' || !apiKey)
      throw new MissingProviderCredentialsError('Configure an OpenAI API key');
    if (
      context.credentials.baseUrl &&
      providerConnection(
        { baseUrl: context.credentials.baseUrl, apiKey: 'validation', compatibleApiKey: 'validation' },
        endpointOptions,
      ).baseUrl !== baseURL
    )
      throw new ProviderError('invalid_request', 'Custom endpoints must select the compatible transport');
    return new OpenAI({
      apiKey,
      baseURL,
      fetch: providerFetch(context, probeFetch ?? options.fetch),
      maxRetries: options.maxRetries ?? 2,
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
      const models = await client(context).models.list({ signal: context.signal });
      const result = [];
      for await (const model of models) {
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
      const tools: Tool[] = (request.tools ?? []).map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.schema,
        strict: false,
      }));
      if (request.allowWeb) tools.push({ type: webSearchType });
      const transcript = input(request);
      const stream = await client(context).responses.create(
        {
          model: request.model,
          temperature: validateTemperature(request.temperature),
          input: transcript,
          instructions:
            request.messages
              .filter((message) => message.role === 'system')
              .map(text)
              .join('\n\n') || undefined,
          stream: options.streaming !== false,
          store: false,
          include: ['reasoning.encrypted_content'],
          ...(tools.length ? { tools } : {}),
          ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
          ...(request.effort ? { reasoning: { effort: effort.parse(request.effort) } } : {}),
          ...(request.schema
            ? {
                text: {
                  format: {
                    type: 'json_schema',
                    name: responseSchemaName(request.schemaName),
                    schema: request.schema,
                    strict: true,
                  },
                },
              }
            : request.responseFormat
              ? { text: { format: { type: request.responseFormat } } }
              : {}),
        },
        { signal: context.signal },
      );
      let completed = false;
      let authoritativeUsage = 'output' in stream ? responseUsage(stream) : undefined;
      try {
        for await (const event of responseEvents(stream)) {
          if (
            event.type === 'response.completed' ||
            event.type === 'response.incomplete' ||
            event.type === 'response.failed'
          )
            authoritativeUsage ??= responseUsage(event.response);
          if (event.type === 'response.output_text.delta') yield { type: 'text', text: event.delta };
          if (event.type === 'response.refusal.delta')
            throw new ProviderError('invalid_stream', 'The provider refused the request');
          if (event.type === 'error' || event.type === 'response.failed')
            throw new ProviderError('invalid_stream', 'The provider failed to generate a response');
          if (event.type !== 'response.completed' && event.type !== 'response.incomplete') continue;
          if (completed)
            throw new ProviderError('invalid_stream', 'Provider emitted multiple completion events');
          const response = event.response;
          if (
            event.type === 'response.incomplete' &&
            response.incomplete_details?.reason !== 'max_output_tokens'
          )
            throw new ProviderError('invalid_stream', 'The provider could not complete the response');
          completed = true;
          let hasTools = false;
          for (const item of response.output) {
            if (item.type === 'function_call') {
              hasTools = true;
              yield {
                type: 'tool_call',
                id: item.call_id,
                name: item.name,
                arguments: argumentsSchema.parse(JSON.parse(item.arguments)),
              };
            }
            if (item.type !== 'message') continue;
            for (const block of item.content) {
              if (block.type === 'refusal')
                throw new ProviderError('invalid_stream', 'The provider refused the request');
              if (block.type !== 'output_text') continue;
              for (const annotation of block.annotations) {
                if (annotation.type === 'url_citation')
                  yield {
                    type: 'citation',
                    url: annotation.url,
                    title: annotation.title,
                    start: annotation.start_index,
                    end: annotation.end_index,
                  };
              }
            }
          }
          yield {
            type: 'continuation',
            provider: request.provider,
            model: request.model,
            data: [...transcript, ...response.output],
          };
          yield {
            type: 'finish',
            reason: event.type === 'response.incomplete' ? 'length' : hasTools ? 'tool_calls' : 'complete',
            usage: responseUsage(response),
          };
        }
        if (!completed)
          throw new ProviderError('invalid_stream', 'Provider ended without a completed response');
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
