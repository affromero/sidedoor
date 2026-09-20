import { z } from 'zod';
import type { ProviderReadiness } from '../ai/browser';
import { abortable } from '../runtime/abort';
import { readRequestBytes } from '../runtime/request';

const models = z.array(z.object({ id: z.string().min(1) }));
const compatiblePage = z.object({ object: z.literal('list'), data: models });
const anthropicPage = z.object({
  data: models,
  has_more: z.boolean(),
  first_id: z.string().nullable(),
  last_id: z.string().nullable(),
});

/** These exact model-list routes document authentication. Public/custom catalogs do not inherit proof. */
const compatibleEndpoints = new Set([
  'https://api.openai.com/v1/models',
  'https://generativelanguage.googleapis.com/v1beta/openai/models',
  'https://api.groq.com/openai/v1/models',
  'https://api.x.ai/v1/models',
  'https://api.deepseek.com/models',
  'https://api.deepseek.com/v1/models',
  'https://api.mistral.ai/v1/models',
]);

function authenticates(endpoint: string, bytes: Uint8Array): boolean {
  const url = new URL(endpoint);
  const path = `${url.origin}${url.pathname}`;
  const schema =
    path === 'https://api.anthropic.com/v1/models'
      ? anthropicPage
      : compatibleEndpoints.has(path)
        ? compatiblePage
        : undefined;
  if (!schema || url.username || url.password || url.hash) return false;
  // Only the bounded first-page parameter used by the Anthropic SDK is part of this contract.
  if (url.search && !(path === 'https://api.anthropic.com/v1/models' && url.search === '?limit=1'))
    return false;
  try {
    return schema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))).success;
  } catch {
    return false;
  }
}

/** Preserve SDK HTTP/auth/error handling while bounding raw probe responses before SDK parsing. */
export function modelCredentialProbe(signal: AbortSignal, implementation: typeof fetch = globalThis.fetch) {
  const responses = new WeakMap<Response, { endpoint: string; bytes: Uint8Array }>();
  const probeFetch: typeof fetch = async (input, init) => {
    const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const combined = inherited ? AbortSignal.any([signal, inherited]) : signal;
    combined.throwIfAborted();
    const endpoint = input instanceof Request ? input.url : String(input);
    const response = await implementation(input, { ...init, signal: combined, redirect: 'error' });
    if (combined.aborted) {
      await abortable(Promise.resolve(response.body?.cancel()), combined);
      combined.throwIfAborted();
    }
    if (response.redirected) {
      await abortable(Promise.resolve(response.body?.cancel()), combined);
      throw new Error('Credential probe redirected');
    }
    const bytes = await abortable(
      readRequestBytes({ body: response.body, signal: combined }, 64 * 1024),
      combined,
    );
    const bounded = new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    responses.set(bounded, { endpoint, bytes });
    return bounded;
  };
  return {
    fetch: probeFetch,
    async readiness(response: Response): Promise<ProviderReadiness> {
      await abortable(Promise.resolve(response.body?.cancel()), signal);
      signal.throwIfAborted();
      const captured = responses.get(response);
      return {
        code: 'ready',
        checkedAt: Date.now(),
        ...(response.status === 200 && captured && authenticates(captured.endpoint, captured.bytes)
          ? { authentication: 'verified' as const }
          : {}),
      };
    },
  };
}
