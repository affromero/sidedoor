import type { TokenUsage } from './index';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Only terminal CLI events report invocation totals; assistant message usage is partial. */
export function cliTokenUsage(provider: 'codex' | 'claude-code', event: unknown): TokenUsage | undefined {
  const envelope = record(event);
  if (envelope?.type !== (provider === 'codex' ? 'turn.completed' : 'result')) return undefined;
  const usage = record(envelope.usage);
  if (!usage) return undefined;
  const count = (field: string) => {
    const value = usage[field];
    return typeof value === 'number' ? knownTokenSum(value) : null;
  };
  const cachedInputTokens = count(provider === 'codex' ? 'cached_input_tokens' : 'cache_read_input_tokens');
  const cacheWriteTokens = count(
    provider === 'codex' ? 'cache_write_input_tokens' : 'cache_creation_input_tokens',
  );
  const inputTokens =
    provider === 'codex'
      ? count('input_tokens')
      : knownTokenSum(count('input_tokens'), cachedInputTokens, cacheWriteTokens);
  const outputTokens = count('output_tokens');
  const reasoningTokens = provider === 'codex' ? count('reasoning_output_tokens') : null;
  const invalidInput =
    inputTokens !== null &&
    ((cachedInputTokens !== null && cachedInputTokens > inputTokens) ||
      (cacheWriteTokens !== null && cacheWriteTokens > inputTokens) ||
      (cachedInputTokens !== null &&
        cacheWriteTokens !== null &&
        cachedInputTokens + cacheWriteTokens > inputTokens));
  return {
    inputTokens: invalidInput ? null : inputTokens,
    outputTokens:
      outputTokens !== null && reasoningTokens !== null && reasoningTokens > outputTokens
        ? null
        : outputTokens,
    cachedInputTokens: invalidInput ? null : cachedInputTokens,
    cacheWriteTokens: invalidInput ? null : cacheWriteTokens,
    reasoningTokens:
      outputTokens !== null && reasoningTokens !== null && reasoningTokens > outputTokens
        ? null
        : reasoningTokens,
  };
}

const incompleteGeneration = Symbol.for('thesidedoor.incomplete-generation');
const reportedGenerationUsage = Symbol.for('thesidedoor.reported-generation-usage');

/** Carry measured usage across a failed invocation without retaining provider payloads. */
export class GenerationUsageError extends Error {
  readonly [reportedGenerationUsage] = true;
  readonly usage: Readonly<TokenUsage>;
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, usage: TokenUsage, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GenerationUsageError';
    this.usage = Object.freeze(normalizeUsage(usage));
    const cause = options?.cause;
    if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') this.code = cause.code;
    if (
      cause instanceof Error &&
      'status' in cause &&
      typeof cause.status === 'number' &&
      Number.isInteger(cause.status)
    ) {
      this.status = cause.status;
    }
  }
}

/** Reported terminal usage survives rejection of an unusable model response. */
export class IncompleteGenerationError extends Error {
  readonly [incompleteGeneration] = true;
  readonly usage: Readonly<TokenUsage>;
  constructor(
    readonly reason: 'length' | 'tool_calls',
    usage?: TokenUsage,
  ) {
    super('AI extraction did not complete. Increase its output limit or shorten the input.');
    this.name = 'IncompleteGenerationError';
    this.usage = Object.freeze(normalizeUsage(usage));
  }
}

function normalizeUsage(value: unknown): TokenUsage {
  const usage = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const count = (key: string): number | null =>
    typeof usage[key] === 'number' ? knownTokenSum(usage[key]) : null;
  return {
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    cachedInputTokens: count('cachedInputTokens'),
    cacheWriteTokens: count('cacheWriteTokens'),
    reasoningTokens: count('reasoningTokens'),
  };
}

/** The cross-bundle brand identifies the error shape; measurements are still validated. */
export function usageFromGenerationError(error: unknown): TokenUsage {
  return reportedUsageFromGenerationError(error) ?? normalizeUsage(undefined);
}

/** Undefined distinguishes an unrelated error from a measured invocation with unknown totals. */
export function reportedUsageFromGenerationError(error: unknown): TokenUsage | undefined {
  if (
    error !== null &&
    typeof error === 'object' &&
    ((incompleteGeneration in error && error[incompleteGeneration] === true) ||
      (reportedGenerationUsage in error && error[reportedGenerationUsage] === true)) &&
    'usage' in error
  )
    return normalizeUsage(error.usage);
  return undefined;
}

/** Aggregate measurements without treating missing provider data as zero. */
export function sumTokenUsage(...measurements: readonly TokenUsage[]): TokenUsage {
  return {
    inputTokens: knownTokenSum(...measurements.map((usage) => usage.inputTokens)),
    outputTokens: knownTokenSum(...measurements.map((usage) => usage.outputTokens)),
    cachedInputTokens: knownTokenSum(...measurements.map((usage) => usage.cachedInputTokens)),
    cacheWriteTokens: knownTokenSum(...measurements.map((usage) => usage.cacheWriteTokens)),
    reasoningTokens: knownTokenSum(...measurements.map((usage) => usage.reasoningTokens)),
  };
}

/** Missing or invalid measurements cannot establish an inclusive token total. */
export function knownTokenSum(...counts: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  for (const count of counts) {
    if (count === null || count === undefined || !Number.isSafeInteger(count) || count < 0) return null;
    total += count;
  }
  return Number.isSafeInteger(total) ? total : null;
}

/** Derive omitted partitions only when an authoritative total uniquely determines them. */
export function inclusiveTokenTotals(parts: {
  input?: number;
  output?: number;
  additionalInput?: number;
  additionalOutput?: number;
  total?: number;
}): { inputTokens: number | null; outputTokens: number | null } {
  const unknown = { inputTokens: null, outputTokens: null };
  if (Object.values(parts).some((value) => value !== undefined && knownTokenSum(value) === null))
    return unknown;
  let inputTokens = knownTokenSum(parts.input, parts.additionalInput);
  let outputTokens = knownTokenSum(parts.output, parts.additionalOutput);
  const total = parts.total;
  if (total === undefined) return { inputTokens, outputTokens };
  const base = knownTokenSum(parts.input, parts.output);
  if (base !== null && base > total) return unknown;
  if (inputTokens !== null && outputTokens !== null)
    return inputTokens + outputTokens === total ? { inputTokens, outputTokens } : unknown;
  if (inputTokens !== null && parts.output !== undefined) {
    if (total - inputTokens < parts.output) return unknown;
    outputTokens = total - inputTokens;
  } else if (outputTokens !== null && parts.input !== undefined) {
    if (total - outputTokens < parts.input) return unknown;
    inputTokens = total - outputTokens;
  } else if (base === total && parts.input !== undefined && parts.output !== undefined) {
    inputTokens = parts.input;
    outputTokens = parts.output;
  }
  return { inputTokens, outputTokens };
}
