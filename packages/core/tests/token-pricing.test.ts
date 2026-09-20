import { describe, expect, it } from 'vitest';
import { estimateTokenCost } from '../src/observability/pricing';

describe('token pricing', () => {
  it('prices cached reads and cache creation as subsets of inclusive input', () => {
    expect(
      estimateTokenCost(
        {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cachedInputTokens: 200_000,
          cacheWriteTokens: 100_000,
          reasoningTokens: 50_000,
        },
        {
          inputPerMillion: 3,
          outputPerMillion: 15,
          cachedInputPerMillion: 0.3,
          cacheWritePerMillion: 3.75,
        },
      ),
    ).toBeCloseTo(4.035);
  });
  it('does not invent prices or usage for incomplete measurements', () => {
    expect(estimateTokenCost({ inputTokens: 10, outputTokens: 2 }, null)).toBeNull();
    expect(
      estimateTokenCost({ inputTokens: null, outputTokens: 2 }, { inputPerMillion: 1, outputPerMillion: 2 }),
    ).toBeNull();
    expect(
      estimateTokenCost(
        { inputTokens: 10, outputTokens: 2, cachedInputTokens: 2, cacheWriteTokens: 0 },
        { inputPerMillion: 1, outputPerMillion: 2 },
      ),
    ).toBeNull();
  });
  it('uses inclusive totals when all input partitions have an explicitly equal price', () => {
    expect(
      estimateTokenCost(
        { inputTokens: 1_000_000, outputTokens: 0 },
        { inputPerMillion: 2, outputPerMillion: null, cachedInputPerMillion: 2, cacheWritePerMillion: 2 },
      ),
    ).toBe(2);
  });
  it('distinguishes explicitly free token billing from unknown prices', () => {
    expect(
      estimateTokenCost(
        { inputTokens: null, outputTokens: null },
        { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0, cacheWritePerMillion: 0 },
      ),
    ).toBe(0);
    expect(
      estimateTokenCost(
        { inputTokens: 0, outputTokens: 0 },
        { inputPerMillion: null, outputPerMillion: null },
      ),
    ).toBe(0);
  });
  it('rejects inconsistent partitions rather than subtracting them into a negative cost', () => {
    expect(
      estimateTokenCost(
        { inputTokens: 10, outputTokens: 0, cachedInputTokens: 9, cacheWriteTokens: 9 },
        { inputPerMillion: 1, outputPerMillion: 2, cachedInputPerMillion: 1, cacheWritePerMillion: 1 },
      ),
    ).toBeNull();
  });

  it('rejects invalid reported measurements even when token billing is explicitly free', () => {
    const pricing = {
      inputPerMillion: 0,
      outputPerMillion: 0,
      cachedInputPerMillion: 0,
      cacheWritePerMillion: 0,
    };
    for (const usage of [
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 1.5, outputTokens: 0 },
      { inputTokens: 10, outputTokens: 0, cachedInputTokens: 11 },
      { inputTokens: 10, outputTokens: 0, cachedInputTokens: 6, cacheWriteTokens: 6 },
      { inputTokens: 0, outputTokens: 1, reasoningTokens: 2 },
    ])
      expect(estimateTokenCost(usage, pricing)).toBeNull();
  });
});
