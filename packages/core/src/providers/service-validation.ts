import { z } from 'zod';
import type { CredentialValidation, ProviderReadiness } from '../ai/browser';
import { abortable } from '../runtime/process/abort';
import { readRequestBytes } from '../runtime/process/request';
import { providerCredentials, type ProviderModality } from './catalog';

const nonempty = z.string().min(1);
const record = z.record(z.string(), z.unknown());
const integer = z.number().int().nonnegative();

/** Each protocol is an authenticated service contract, independent of application provider aliases. */
const protocols = {
  pexels: {
    origin: 'https://api.pexels.com',
    path: '/v1/search?query=language%20learning&per_page=1',
    header: 'authorization',
    prefix: '',
    proof: z.object({
      photos: z.array(z.object({ id: z.number().int().positive() })),
      page: integer,
      per_page: integer,
      total_results: integer,
    }),
  },
  google: {
    origin: 'https://generativelanguage.googleapis.com',
    path: '/v1beta/models?pageSize=1',
    header: 'x-goog-api-key',
    prefix: '',
    proof: z.object({ models: z.array(z.object({ name: nonempty })) }),
  },
  elevenlabs: {
    origin: 'https://api.elevenlabs.io',
    path: '/v1/user',
    header: 'xi-api-key',
    prefix: '',
    proof: z.object({ user_id: nonempty, subscription: record }),
  },
  cartesia: {
    origin: 'https://api.cartesia.ai',
    path: '/voices?limit=1',
    header: 'authorization',
    prefix: 'Bearer ',
    proof: z.object({ data: z.array(z.object({ id: nonempty })), has_more: z.boolean() }),
  },
  hume: {
    origin: 'https://api.hume.ai',
    path: '/v0/tts/voices?provider=CUSTOM_VOICE&page_size=1',
    header: 'X-Hume-Api-Key',
    prefix: '',
    proof: z.object({
      voices_page: z.array(record),
      page_number: integer,
      page_size: integer,
      total_pages: integer,
    }),
  },
  fal: {
    origin: 'https://api.fal.ai',
    path: '/v1/models/pricing?endpoint_id=fal-ai/flux/dev',
    header: 'authorization',
    prefix: 'Key ',
    proof: z.object({
      prices: z
        .array(
          z.object({
            endpoint_id: nonempty,
            unit_price: z.number().nonnegative(),
            unit: nonempty,
            currency: nonempty,
          }),
        )
        .refine((prices) => prices.some((price) => price.endpoint_id === 'fal-ai/flux/dev')),
      has_more: z.boolean(),
      next_cursor: z.string().nullable(),
    }),
  },
  replicate: {
    origin: 'https://api.replicate.com',
    path: '/v1/account',
    header: 'authorization',
    prefix: 'Bearer ',
    proof: z.object({ username: nonempty, type: z.enum(['user', 'organization']) }),
  },
  assemblyai: {
    origin: 'https://api.assemblyai.com',
    path: '/v2/transcript?limit=1',
    header: 'authorization',
    prefix: '',
    proof: z.object({
      transcripts: z.array(record),
      page_details: z.object({ limit: integer, result_count: integer }),
    }),
  },
  gladia: {
    origin: 'https://api.gladia.io',
    path: '/v2/pre-recorded',
    header: 'x-gladia-key',
    prefix: '',
    proof: z.object({
      items: z.array(record),
      first: z.string(),
      current: z.string(),
      next: z.string().nullable(),
    }),
  },
  playht: {
    origin: 'https://api.play.ht',
    path: '/api/v2/cloned-voices',
    header: 'authorization',
    prefix: '',
    proof: z.array(z.object({ id: nonempty, name: z.string() })),
  },
  deepgram: {
    origin: 'https://api.deepgram.com',
    path: '/v1/projects',
    header: 'authorization',
    prefix: 'Token ',
    proof: z.object({ projects: z.array(z.object({ project_id: nonempty, name: z.string() })) }),
  },
  speechmatics: {
    origin: 'https://eu1.asr.api.speechmatics.com',
    path: '/v2/jobs?limit=1',
    header: 'authorization',
    prefix: 'Bearer ',
    proof: z.object({ jobs: z.array(record) }),
  },
  rime: {
    origin: 'https://users.rime.ai',
    path: '/oov',
    header: 'authorization',
    prefix: 'Bearer ',
    proof: z.array(z.string()),
  },
  sunoapi: {
    origin: 'https://api.sunoapi.org',
    path: '/api/v1/generate/credit',
    header: 'authorization',
    prefix: 'Bearer ',
    proof: z.object({ code: z.literal(200), data: integer, msg: z.string() }),
  },
} as const;

export type ServiceCredentialProtocol = keyof typeof protocols;

/** Resolve catalog aliases only after checking the requested modality. */
export function providerServiceProtocol(
  provider: string,
  modality: ProviderModality,
): ServiceCredentialProtocol | null {
  const authority = providerCredentials(provider, modality).credentialProvider;
  return Object.hasOwn(protocols, authority) ? (authority as ServiceCredentialProtocol) : null;
}

/** Metadata only. Never replaces a caller's already selected destination. */
export function serviceCredentialOrigin(protocol: ServiceCredentialProtocol): string {
  if (!Object.hasOwn(protocols, protocol)) throw new Error('Unknown credential protocol');
  return protocols[protocol].origin;
}

export interface ServiceCredentialSelection {
  protocol: ServiceCredentialProtocol;
  /** Explicit selected credential destination. Custom destinations require their own authentication contract. */
  origin: string;
  credentials: Readonly<{ apiKey?: string; userId?: string }>;
  /** Required for Cartesia and captured from the generation transport's API contract. */
  apiVersion?: string;
}

function result(
  status: CredentialValidation['status'],
  code: ProviderReadiness['code'],
  action?: ProviderReadiness['action'],
): CredentialValidation {
  return {
    status,
    readiness: {
      code,
      checkedAt: Date.now(),
      ...(action ? { action } : {}),
      ...(status === 'valid' ? { authentication: 'verified' as const } : {}),
    },
  };
}

/** No environment lookup, generation, redirects, or raw vendor payloads escape this check. */
export async function validateServiceCredentials(
  selection: ServiceCredentialSelection,
  signal?: AbortSignal,
): Promise<CredentialValidation> {
  signal?.throwIfAborted();
  if (!Object.hasOwn(protocols, selection.protocol)) throw new Error('Unknown credential protocol');
  const protocol = protocols[selection.protocol];
  let origin: URL;
  try {
    origin = new URL(selection.origin);
  } catch {
    return result('inconclusive', 'not_configured', 'configure');
  }
  if (origin.href !== `${protocol.origin}/`) return result('inconclusive', 'unsupported', 'configure');
  // Capture the exact credentials before the first asynchronous operation.
  const { apiKey, userId } = selection.credentials;
  if (!apiKey?.trim() || (selection.protocol === 'playht' && !userId?.trim()))
    return result('missing', 'missing_credentials', 'configure');
  if (selection.protocol === 'cartesia' && !selection.apiVersion?.trim())
    return result('inconclusive', 'not_configured', 'configure');
  const deadline = AbortSignal.timeout(10_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const protocolId = selection.protocol;
  const headers = new Headers();
  try {
    headers.set(protocol.header, `${protocol.prefix}${apiKey}`);
    if (protocolId === 'playht') headers.set('x-user-id', userId!);
    if (protocolId === 'cartesia') headers.set('Cartesia-Version', selection.apiVersion!);
    if (protocolId === 'rime') headers.set('content-type', 'application/json');
  } catch {
    return result('inconclusive', 'not_configured', 'configure');
  }
  const work = async (): Promise<CredentialValidation> => {
    const response = await fetch(new URL(protocol.path, origin), {
      headers,
      signal: combined,
      redirect: 'error',
      ...(protocolId === 'rime' ? { method: 'POST', body: JSON.stringify({ text: 'hello' }) } : {}),
    });
    if (combined.aborted) {
      await response.body?.cancel();
      combined.throwIfAborted();
    }
    if (response.status !== 200) {
      // Observe cleanup even when a boundary ignores cancellation; the outer deadline bounds waiting.
      await response.body?.cancel();
      return response.status === 401
        ? result('rejected', 'not_authenticated', 'login')
        : result(
            'inconclusive',
            'unreachable',
            protocolId === 'google' && response.status === 403 ? 'configure' : 'retry',
          );
    }
    const bytes = await readRequestBytes({ body: response.body, signal: combined }, 64 * 1024);
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      protocolId === 'sunoapi' &&
      z.object({ code: z.literal(401), msg: z.string() }).safeParse(body).success
    )
      return result('rejected', 'not_authenticated', 'login');
    return protocol.proof.safeParse(body).success
      ? result('valid', 'ready')
      : result('inconclusive', 'unreachable', 'retry');
  };
  try {
    const validation = await abortable(work(), combined);
    signal?.throwIfAborted();
    return validation;
  } catch {
    signal?.throwIfAborted();
    return result('inconclusive', 'unreachable', 'retry');
  }
}
