import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { MetricCollector } from '../observability/index';
import { z } from 'zod';
import { abortable } from '../runtime/process/abort';
import { interruptibleStream } from '../runtime/process/stream';
import { GenerationUsageError, reportedUsageFromGenerationError } from './usage';
import type {
  Capability,
  ProviderDescriptor,
  ProviderReadiness,
  ModelDescriptor,
  CredentialValidation,
} from './browser';
export type {
  Capability,
  ProviderDescriptor,
  ProviderReadiness,
  ModelDescriptor,
  CredentialValidation,
} from './browser';

export type CredentialValues = Record<string, string | number | boolean>;
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; url: string }
  | { type: 'image' | 'audio'; mediaType: string; data: Uint8Array };
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: readonly ContentPart[];
  toolCallId?: string;
  toolCalls?: readonly { id: string; name: string; arguments: Record<string, unknown> }[];
}
export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}
export const webSearchOptionsSchema = z
  .object({
    allowedDomains: z.array(z.string().min(1)).nullable().optional(),
    blockedDomains: z.array(z.string().min(1)).nullable().optional(),
    maxUses: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    userLocation: z
      .object({
        type: z.literal('approximate'),
        city: z.string().nullable().optional(),
        country: z.string().nullable().optional(),
        region: z.string().nullable().optional(),
        timezone: z.string().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.allowedDomains == null || value.blockedDomains == null,
    'Web search cannot combine allowed and blocked domains',
  );
export type WebSearchOptions = z.infer<typeof webSearchOptionsSchema>;
export interface GenerationRequest {
  provider: string;
  model: string;
  messages: readonly Message[];
  required?: readonly Capability[];
  tools?: readonly ToolDefinition[];
  schema?: Record<string, unknown>;
  schemaName?: string;
  responseFormat?: 'json_object';
  allowWeb?: boolean;
  webSearch?: WebSearchOptions;
  effort?: string;
  adaptiveThinking?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  consumerId?: string;
  conversationId?: string;
  credentialOwnerId?: string;
  /** Server-side transcript state emitted by the same provider and model, including encrypted reasoning. */
  continuation?: { provider: string; model: string; data: unknown; signature?: string };
}
export interface TokenUsage {
  /** Inclusive total, including cached reads and cache creation. Null when not fully measured. */
  inputTokens: number | null;
  /** Inclusive total, including reasoning. Breakdown fields are subsets, never additional usage. */
  outputTokens: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
}
export type GenerationEvent =
  | { type: 'text'; text: string }
  | { type: 'audio'; data: Uint8Array; mediaType: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'continuation'; provider: string; model: string; data: unknown; signature?: string }
  | { type: 'citation'; url: string; title: string; start: number; end: number }
  | { type: 'finish'; reason: 'complete' | 'length' | 'tool_calls'; usage?: TokenUsage };
export interface ProviderContext {
  credentials: CredentialValues;
  signal: AbortSignal;
  onRetry?: () => void;
}
export interface ProviderAdapter {
  descriptor: ProviderDescriptor;
  supportsWebSearchOptions?: boolean;
  /** The transport supplies HTTP attempt deadlines, not a total generation deadline. */
  managesAttemptTimeouts?: boolean;
  /** Validate endpoint and credential selection locally, without contacting the provider. */
  validateConfiguration?(context: ProviderContext): void;
  readiness(context: ProviderContext): Promise<ProviderReadiness>;
  models(context: ProviderContext): Promise<readonly ModelDescriptor[]>;
  generate(request: GenerationRequest, context: ProviderContext): AsyncIterable<GenerationEvent>;
}
export interface CredentialStore {
  /** Resolves this provider's explicitly configured instance credentials only. */
  resolve(provider: string): Promise<CredentialValues>;
}
export interface RegistryOptions {
  providers: readonly ProviderAdapter[];
  credentials: CredentialStore;
  metrics?: MetricCollector;
  /** Provider mode has no whole-request deadline and rejects request.timeoutMs. */
  timeoutMode?: 'request' | 'provider';
  /** Supply the same secret to workers that must resume each other's server-side tool turns. */
  continuationSecret?: Uint8Array;
}

export class ProviderError extends Error {
  constructor(
    public readonly code:
      'unknown_provider' | 'unsupported_capability' | 'invalid_request' | 'invalid_stream',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class MissingProviderCredentialsError extends ProviderError {
  constructor(message: string) {
    super('invalid_request', message);
    this.name = 'MissingProviderCredentialsError';
  }
}

export function validateTemperature(value: number | undefined): number | undefined {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new ProviderError('invalid_request', 'Temperature must be finite');
  }
  return value;
}

export function imageUrl(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProviderError('invalid_request', 'Image URL must be a nonempty string');
  }
  return value;
}

export function responseSchemaName(value: string | undefined): string {
  if (value === undefined) return 'result';
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new ProviderError(
      'invalid_request',
      'Schema name must contain 1 to 64 letters, digits, underscores or hyphens',
    );
  }
  return value;
}

export class ProviderCleanupError extends Error {
  readonly code = 'cleanup_failed';
  constructor(
    readonly unconfirmed: boolean,
    options: ErrorOptions,
  ) {
    super(unconfirmed ? 'Provider cleanup could not be confirmed' : 'Provider cleanup failed', options);
    this.name = 'ProviderCleanupError';
  }
}

/** One selected backend per request. Failures propagate; they never select another provider. */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();
  private readonly continuationSecret: Buffer;

  constructor(private readonly options: RegistryOptions) {
    this.continuationSecret = Buffer.from(options.continuationSecret ?? randomBytes(32));
    if (this.continuationSecret.length !== 32) throw new Error('Continuation secret must contain 32 bytes');
    for (const provider of options.providers) {
      if (this.providers.has(provider.descriptor.id))
        throw new Error(`Duplicate provider: ${provider.descriptor.id}`);
      this.providers.set(provider.descriptor.id, provider);
    }
  }

  descriptors(): ProviderDescriptor[] {
    return structuredClone([...this.providers.values()].map((provider) => provider.descriptor));
  }

  private signContinuation(
    request: GenerationRequest,
    credentials: CredentialValues,
    continuation: NonNullable<GenerationRequest['continuation']>,
  ): string {
    if (!request.consumerId?.trim() || !request.conversationId?.trim() || !request.credentialOwnerId?.trim())
      throw new ProviderError(
        'invalid_request',
        'Continuation requires server-derived caller, conversation and credential owner identities',
      );
    const configuration = createHash('sha256')
      .update(JSON.stringify(Object.entries(credentials).sort(([a], [b]) => a.localeCompare(b))))
      .digest('hex');
    return createHmac('sha256', this.continuationSecret)
      .update(
        JSON.stringify({
          provider: continuation.provider,
          model: continuation.model,
          data: continuation.data,
          consumerId: request.consumerId ?? null,
          conversationId: request.conversationId ?? null,
          credentialOwnerId: request.credentialOwnerId ?? null,
          configuration,
        }),
      )
      .digest('hex');
  }

  private adapter(id: string): ProviderAdapter {
    const adapter = this.providers.get(id);
    if (!adapter) throw new ProviderError('unknown_provider', `Unknown provider: ${id}`);
    return adapter;
  }

  async readiness(provider: string, signal = AbortSignal.timeout(10_000)): Promise<ProviderReadiness> {
    signal.throwIfAborted();
    const adapter = this.adapter(provider);
    const credentials = await abortable(this.options.credentials.resolve(provider), signal);
    return abortable(adapter.readiness({ credentials, signal }), signal);
  }

  async models(provider: string, signal = AbortSignal.timeout(10_000)): Promise<readonly ModelDescriptor[]> {
    signal.throwIfAborted();
    const adapter = this.adapter(provider);
    const credentials = await abortable(this.options.credentials.resolve(provider), signal);
    return abortable(adapter.models({ credentials, signal }), signal);
  }

  /** Reuse the selected transport's probe without treating outages as rejected credentials. */
  async validateCredentials(provider: string, signal?: AbortSignal): Promise<CredentialValidation> {
    signal?.throwIfAborted();
    const adapter = this.adapter(provider);
    const deadline = AbortSignal.timeout(10_000);
    const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let readiness: ProviderReadiness;
    try {
      const credentials = await abortable(this.options.credentials.resolve(provider), probeSignal);
      signal?.throwIfAborted();
      if (adapter.descriptor.transport !== 'api' || credentials.allowAnonymous === true)
        return {
          status: 'inconclusive',
          readiness: { code: 'unsupported', checkedAt: Date.now(), action: 'configure' },
        };
      readiness = await abortable(adapter.readiness({ credentials, signal: probeSignal }), probeSignal);
    } catch {
      signal?.throwIfAborted();
      readiness = { code: 'unreachable', checkedAt: Date.now(), action: 'retry' };
    }
    signal?.throwIfAborted();
    const status =
      readiness.code === 'ready' && readiness.authentication === 'verified'
        ? 'valid'
        : readiness.code === 'not_authenticated'
          ? 'rejected'
          : readiness.code === 'missing_credentials'
            ? 'missing'
            : 'inconclusive';
    return { status, readiness };
  }

  generate(request: GenerationRequest): AsyncGenerator<GenerationEvent> {
    return interruptibleStream((signal) => this.run({ ...request, signal }), {
      signal: request.signal,
      isCleanupError: (error) => error instanceof ProviderCleanupError,
    });
  }

  private async *run(request: GenerationRequest): AsyncGenerator<GenerationEvent> {
    const bindings = [request.consumerId, request.conversationId, request.credentialOwnerId];
    const resumable = bindings.every((value) => Boolean(value?.trim()));
    if ((request.continuation || bindings.some((value) => value !== undefined)) && !resumable)
      throw new ProviderError(
        'invalid_request',
        'Continuation requires server-derived caller, conversation and credential owner identities',
      );
    const adapter = this.adapter(request.provider);
    const providerTimeout = this.options.timeoutMode === 'provider';
    if (providerTimeout && (!adapter.managesAttemptTimeouts || request.timeoutMs !== undefined))
      throw new ProviderError(
        'invalid_request',
        'Provider timing requires adapter support and no request timeout',
      );
    if (request.webSearch !== undefined) {
      webSearchOptionsSchema.parse(request.webSearch);
      if (!request.allowWeb)
        throw new ProviderError('invalid_request', 'Web search settings require web search to be enabled');
      if (!adapter.supportsWebSearchOptions)
        throw new ProviderError(
          'unsupported_capability',
          'This transport does not support web search settings',
        );
    }
    const required = new Set<Capability>(request.required ?? ['text']);
    if (request.schema || request.responseFormat) required.add('structured');
    if (request.allowWeb) required.add('web');
    if (request.tools?.length) required.add('tools');
    if (
      request.messages.some((message) =>
        message.content.some((part) => part.type === 'image' || part.type === 'image_url'),
      )
    )
      required.add('vision');
    for (const capability of required) {
      if (!adapter.descriptor.capabilities.includes(capability))
        throw new ProviderError(
          'unsupported_capability',
          `${request.provider} does not support ${capability}`,
        );
    }
    const timeout = request.timeoutMs ?? 600_000;
    const maxOutputBytes = request.maxOutputBytes ?? 16 * 1024 * 1024;
    if (
      !request.model ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 1
    )
      throw new ProviderError('invalid_request', 'A model and positive timeout are required');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(providerTimeout ? [] : [AbortSignal.timeout(timeout)]),
      ...(request.signal ? [request.signal] : []),
    ]);
    const started = performance.now();
    let firstOutputMs: number | null = null;
    let usage: TokenUsage = { inputTokens: null, outputTokens: null };
    let outcome: 'success' | 'error' | 'cancelled' = 'cancelled';
    let retryCount = 0;
    let outputBytes = 0;
    let terminal: Extract<GenerationEvent, { type: 'finish' }> | undefined;
    let iterator: AsyncIterator<GenerationEvent> | undefined;
    let primary: { error: unknown } | undefined;
    let failureUsage: TokenUsage | undefined;
    let acceptingMeasurements = true;
    const captureFailureUsage = (error: unknown) => {
      const reported = reportedUsageFromGenerationError(error);
      if (acceptingMeasurements && reported) {
        failureUsage = reported;
        usage = reported;
      }
    };
    try {
      signal.throwIfAborted();
      const credentials = await abortable(this.options.credentials.resolve(request.provider), signal);
      let adapterRequest = request;
      if (request.continuation) {
        if (
          typeof request.continuation.data !== 'string' ||
          request.continuation.data.length > 24 * 1024 * 1024
        )
          throw new ProviderError('invalid_request', 'Invalid continuation envelope');
        const supplied = request.continuation.signature;
        const expected = this.signContinuation(request, credentials, request.continuation);
        if (
          request.continuation.provider !== request.provider ||
          request.continuation.model !== request.model ||
          !supplied ||
          !/^[a-f0-9]{64}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))
        )
          throw new ProviderError(
            'invalid_request',
            'Continuation no longer belongs to this caller or credential configuration',
          );
        const envelope = Buffer.from(request.continuation.data, 'base64');
        try {
          const decipher = createDecipheriv('aes-256-gcm', this.continuationSecret, envelope.subarray(0, 12));
          decipher.setAuthTag(envelope.subarray(12, 28));
          const data: unknown = JSON.parse(
            Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString('utf8'),
          );
          adapterRequest = { ...request, continuation: { ...request.continuation, data } };
        } catch {
          throw new ProviderError('invalid_request', 'Invalid continuation envelope');
        }
      }
      signal.throwIfAborted();
      const stream = adapter.generate(adapterRequest, {
        credentials,
        signal,
        onRetry: () => {
          retryCount++;
        },
      });
      iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const pending = iterator.next().catch((error: unknown) => {
          captureFailureUsage(error);
          throw error;
        });
        const next = await abortable(pending, signal);
        if (next.done) break;
        const event = next.value;
        if (event.type === 'text') outputBytes += Buffer.byteLength(event.text);
        if (event.type === 'audio') outputBytes += event.data.byteLength;
        if (event.type === 'tool_call') outputBytes += Buffer.byteLength(JSON.stringify(event));
        if (event.type === 'citation') outputBytes += Buffer.byteLength(JSON.stringify(event));
        if (outputBytes > maxOutputBytes)
          throw new ProviderError('invalid_stream', 'Provider output exceeded the configured limit');
        signal.throwIfAborted();
        if (terminal) throw new ProviderError('invalid_stream', 'Provider emitted data after completion');
        if (event.type === 'finish') {
          terminal = event;
          if (event.usage) usage = { ...event.usage };
          continue;
        }
        if (event.type === 'usage') usage = { ...event.usage };
        if ((event.type === 'text' || event.type === 'audio') && firstOutputMs === null)
          firstOutputMs = performance.now() - started;
        if (event.type === 'continuation') {
          if (!resumable) continue;
          const serialized = JSON.stringify(event.data);
          if (Buffer.byteLength(serialized) > 16 * 1024 * 1024)
            throw new ProviderError('invalid_stream', 'Continuation exceeded the configured limit');
          const nonce = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', this.continuationSecret, nonce);
          const ciphertext = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
          const sealed = {
            ...event,
            data: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64'),
          };
          yield { ...sealed, signature: this.signContinuation(request, credentials, sealed) };
        } else yield event;
      }
      if (!terminal) throw new ProviderError('invalid_stream', 'Provider ended without a completion event');
      signal.throwIfAborted();
      outcome = 'success';
    } catch (error) {
      outcome = signal.aborted ? 'cancelled' : 'error';
      captureFailureUsage(error);
      primary = { error };
    } finally {
      controller.abort();
      let cleanup: ProviderCleanupError | undefined;
      // Abort precedes return(): adapters may be waiting for the signal in a pending next().
      if (iterator?.return) {
        const settlementTimeout = AbortSignal.timeout(5_000);
        try {
          await abortable(iterator.return(), settlementTimeout);
        } catch (error) {
          outcome = 'error';
          cleanup = new ProviderCleanupError(settlementTimeout.aborted, { cause: error });
        }
      }
      if (!cleanup && request.signal?.aborted) outcome = 'cancelled';
      acceptingMeasurements = false;
      this.options.metrics?.record({
        version: 1,
        id: randomUUID(),
        timestamp: Date.now(),
        kind: 'execution',
        operation: 'generate',
        outcome,
        provider: request.provider,
        model: request.model,
        consumerId: request.consumerId,
        credentialOwnerId: request.credentialOwnerId,
        durationMs: performance.now() - started,
        firstOutputMs,
        retryCount,
        ...usage,
        estimatedCost: null,
      });
      if (cleanup) raiseCleanupFailure(cleanup, primary, usage);
    }
    if (primary) {
      if (failureUsage && !reportedUsageFromGenerationError(primary.error))
        throw new GenerationUsageError(
          primary.error instanceof Error ? primary.error.message : 'Provider generation failed',
          failureUsage,
          { cause: primary.error },
        );
      throw primary.error;
    }
    request.signal?.throwIfAborted();
    if (terminal) yield terminal;
  }
}

function raiseCleanupFailure(
  cleanup: ProviderCleanupError,
  primary: { error: unknown } | undefined,
  usage: TokenUsage,
): never {
  const failure = primary
    ? new AggregateError([primary.error, cleanup], 'Provider execution and cleanup failed', {
        cause: cleanup,
      })
    : cleanup;
  throw new GenerationUsageError(failure.message, usage, { cause: failure });
}
