import type { ProviderContext } from './index';

/** SDKs identify retries on their outgoing requests. Only the count enters telemetry. */
export function providerFetch(
  context: ProviderContext,
  implementation: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (Number(headers.get('x-stainless-retry-count') ?? 0) > 0) context.onRetry?.();
    return implementation(input, init);
  };
}
