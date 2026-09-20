import type { TokenUsage } from '../ai/index';
import { knownTokenSum } from '../ai/usage';

export interface TokenPricing {
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cachedInputPerMillion?: number | null;
  cacheWritePerMillion?: number | null;
}

/** Token charges only. Missing measurements or necessary rates never imply zero cost. */
export function estimateTokenCost(usage: TokenUsage, pricing: TokenPricing | null): number | null {
  if (!pricing) return null;
  if (Object.values(usage).some((count) => count != null && knownTokenSum(count) === null)) return null;
  if (usage.inputTokens !== null) {
    const cached = usage.cachedInputTokens;
    const written = usage.cacheWriteTokens;
    if (
      (cached != null && cached > usage.inputTokens) ||
      (written != null && written > usage.inputTokens) ||
      (cached != null && written != null && cached + written > usage.inputTokens)
    )
      return null;
  }
  if (
    usage.outputTokens !== null &&
    usage.reasoningTokens != null &&
    usage.reasoningTokens > usage.outputTokens
  )
    return null;
  const rates = [
    pricing.inputPerMillion,
    pricing.outputPerMillion,
    pricing.cachedInputPerMillion,
    pricing.cacheWritePerMillion,
  ];
  if (rates.every((rate) => rate === 0)) return 0;
  const input = knownTokenSum(usage.inputTokens);
  const output = knownTokenSum(usage.outputTokens);
  if (input === null || output === null) return null;
  const cached = usage.cachedInputTokens == null && input === 0 ? 0 : knownTokenSum(usage.cachedInputTokens);
  const written = usage.cacheWriteTokens == null && input === 0 ? 0 : knownTokenSum(usage.cacheWriteTokens);
  const uniformInputRate =
    pricing.inputPerMillion !== null &&
    pricing.inputPerMillion === pricing.cachedInputPerMillion &&
    pricing.inputPerMillion === pricing.cacheWritePerMillion;
  if (
    (cached !== null && cached > input) ||
    (written !== null && written > input) ||
    (cached !== null && written !== null && cached + written > input)
  )
    return null;
  if (!uniformInputRate && (cached === null || written === null)) return null;
  const partitions = uniformInputRate
    ? ([
        [input, pricing.inputPerMillion],
        [output, pricing.outputPerMillion],
      ] as const)
    : ([
        [input - cached! - written!, pricing.inputPerMillion],
        [cached!, pricing.cachedInputPerMillion],
        [written!, pricing.cacheWritePerMillion],
        [output, pricing.outputPerMillion],
      ] as const);
  let total = 0;
  for (const [tokens, rate] of partitions) {
    if (tokens === 0) continue;
    if (rate == null || !Number.isFinite(rate) || rate < 0) return null;
    total += (tokens / 1_000_000) * rate;
  }
  return Number.isFinite(total) ? total : null;
}
