import { describe, expect, it } from 'vitest';
import {
  cliTokenUsage,
  GenerationUsageError,
  IncompleteGenerationError,
  sumTokenUsage,
  usageFromGenerationError,
  reportedUsageFromGenerationError,
} from '../../src/ai/usage';

describe('failed invocation measurements', () => {
  it('distinguishes unrelated failures from unknown reported totals and retains HTTP status', () => {
    const cause = Object.assign(new Error('Rate limited'), { status: 429 });
    expect(reportedUsageFromGenerationError(cause)).toBeUndefined();
    const error = new GenerationUsageError(
      'Generation failed',
      { inputTokens: null, outputTokens: null },
      { cause },
    );
    expect(error.status).toBe(429);
    expect(error.cause).toBe(cause);
    expect(reportedUsageFromGenerationError(error)).toMatchObject({ inputTokens: null, outputTokens: null });
  });
  it('retains reported usage and the original failure without sharing mutable counts', () => {
    const cause = new Error('process exited');
    const usage = { inputTokens: 100, outputTokens: 30, cachedInputTokens: 40 };
    const error = new GenerationUsageError('Codex execution failed', usage, { cause });
    usage.inputTokens = 999;
    const copy = usageFromGenerationError(error);
    copy.outputTokens = 888;
    expect(error.cause).toBe(cause);
    expect(usageFromGenerationError(error)).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 40,
    });
    expect(() => Object.assign(error.usage, { inputTokens: 1 })).toThrow(TypeError);
  });

  it('validates separately bundled measured errors and preserves unknown measurements', () => {
    expect(
      usageFromGenerationError({
        [Symbol.for('thesidedoor.reported-generation-usage')]: true,
        usage: { inputTokens: -1, outputTokens: 3, cachedInputTokens: '5' },
      }),
    ).toMatchObject({ inputTokens: null, outputTokens: 3, cachedInputTokens: null });
    expect(
      usageFromGenerationError(new GenerationUsageError('failed', { inputTokens: null, outputTokens: null })),
    ).toMatchObject({ inputTokens: null, outputTokens: null });
  });
});

describe('terminal CLI token measurements', () => {
  it('preserves Codex inclusive totals without adding cache and reasoning subsets twice', () => {
    expect(
      cliTokenUsage('codex', {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 60,
          cache_write_input_tokens: 10,
          output_tokens: 30,
          reasoning_output_tokens: 20,
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 60,
      cacheWriteTokens: 10,
      reasoningTokens: 20,
    });
  });

  it('includes Claude cache reads and writes in invocation input totals', () => {
    expect(
      cliTokenUsage('claude-code', {
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 15,
          cache_read_input_tokens: 60,
          cache_creation_input_tokens: 25,
          output_tokens: 30,
        },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 60,
      cacheWriteTokens: 25,
      reasoningTokens: null,
    });
  });

  it('keeps terminal failed Claude invocation usage and ignores partial messages', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    expect(cliTokenUsage('claude-code', { type: 'result', is_error: true, usage })).toMatchObject({
      inputTokens: 10,
      outputTokens: 3,
    });
    expect(cliTokenUsage('claude-code', { type: 'assistant', message: { usage } })).toBeUndefined();
    expect(cliTokenUsage('codex', { type: 'item.completed', usage })).toBeUndefined();
  });

  it('does not invent omitted measurements from older CLI versions', () => {
    expect(
      cliTokenUsage('codex', { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    expect(
      cliTokenUsage('claude-code', { type: 'result', usage: { input_tokens: 10, output_tokens: 3 } }),
    ).toMatchObject({ inputTokens: null, outputTokens: 3 });
    expect(cliTokenUsage('codex', { type: 'turn.completed' })).toBeUndefined();
  });

  it('rejects impossible partitions and invalid counts without losing independent measurements', () => {
    expect(
      cliTokenUsage('codex', {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 8,
          cache_write_input_tokens: 8,
          output_tokens: 3,
          reasoning_output_tokens: 4,
        },
      }),
    ).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    for (const invalid of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '10'])
      expect(
        cliTokenUsage('codex', {
          type: 'turn.completed',
          usage: { input_tokens: invalid, output_tokens: 3 },
        }),
      ).toMatchObject({ inputTokens: null, outputTokens: 3 });
  });
});

describe('incomplete generation measurements', () => {
  it('retains terminal counts and reason independently from mutable caller data', () => {
    const usage = { inputTokens: 12, outputTokens: 3 };
    const error = new IncompleteGenerationError('length', usage);
    usage.inputTokens = 999;
    const copy = usageFromGenerationError(error);
    copy.inputTokens = 888;
    expect(error.reason).toBe('length');
    expect(usageFromGenerationError(error)).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(() => Object.assign(error.usage, { inputTokens: 777 })).toThrow(TypeError);
  });
  it('does not infer final usage from absent or malformed error measurements', () => {
    expect(usageFromGenerationError(new Error('transport failed'))).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
    expect(usageFromGenerationError(new IncompleteGenerationError('tool_calls'))).toMatchObject({
      inputTokens: null,
      outputTokens: null,
    });
    expect(
      usageFromGenerationError({
        [Symbol.for('thesidedoor.incomplete-generation')]: true,
        usage: { inputTokens: -1, outputTokens: '12', cachedInputTokens: Infinity },
      }),
    ).toMatchObject({ inputTokens: null, outputTokens: null, cachedInputTokens: null });
  });
});

describe('usage across generation rounds', () => {
  it('retains cache and reasoning subsets without counting them twice', () => {
    expect(
      sumTokenUsage(
        {
          inputTokens: 100,
          outputTokens: 40,
          cachedInputTokens: 20,
          cacheWriteTokens: 10,
          reasoningTokens: 30,
        },
        {
          inputTokens: 200,
          outputTokens: 60,
          cachedInputTokens: 100,
          cacheWriteTokens: 0,
          reasoningTokens: 40,
        },
      ),
    ).toEqual({
      inputTokens: 300,
      outputTokens: 100,
      cachedInputTokens: 120,
      cacheWriteTokens: 10,
      reasoningTokens: 70,
    });
  });

  it('keeps incomplete totals unknown while retaining independently measured totals', () => {
    expect(
      sumTokenUsage(
        { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20 },
        { inputTokens: null, outputTokens: 60 },
      ),
    ).toEqual({
      inputTokens: null,
      outputTokens: 100,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
  });

  it('reports zero usage when no generation ran', () => {
    expect(sumTokenUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  it('does not publish unsafe or invalid totals', () => {
    expect(
      sumTokenUsage(
        { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: -1 },
        { inputTokens: 1, outputTokens: 2 },
      ),
    ).toMatchObject({ inputTokens: null, outputTokens: null });
  });
});
