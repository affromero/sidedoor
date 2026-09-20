import { afterEach, expect, it, vi } from 'vitest';
import {
  validateServiceCredentials,
  serviceCredentialOrigin,
  providerServiceProtocol,
  type ServiceCredentialSelection,
} from '../src/providers/service-validation';

const selection: ServiceCredentialSelection = {
  protocol: 'elevenlabs',
  origin: 'https://api.elevenlabs.io',
  credentials: { apiKey: 'owner-key' },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('selects explicit service credential authority without broadening supported modalities', () => {
  expect(providerServiceProtocol('suno', 'music')).toBe('sunoapi');
  expect(providerServiceProtocol('minimax', 'speech')).toBe('fal');
  expect(providerServiceProtocol('playht', 'speech')).toBe('playht');
  expect(providerServiceProtocol('openai', 'text')).toBeNull();
  expect(() => providerServiceProtocol('suno', 'text')).toThrow('does not support');
  expect(() => providerServiceProtocol('__proto__', 'text')).toThrow('Unknown provider');
});

it('verifies authenticated Pexels search including an empty result', async () => {
  let request: { url: string; authorization: string | null } | undefined;
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    request = { url: url.href, authorization: new Headers(init.headers).get('authorization') };
    return Response.json({ photos: [], page: 1, per_page: 1, total_results: 0 });
  });
  expect(
    (
      await validateServiceCredentials({
        protocol: 'pexels',
        origin: serviceCredentialOrigin('pexels'),
        credentials: { apiKey: 'personal-pexels-key' },
      })
    ).status,
  ).toBe('valid');
  expect(request).toEqual({
    url: 'https://api.pexels.com/v1/search?query=language%20learning&per_page=1',
    authorization: 'personal-pexels-key',
  });
});

it.each([401, 403, 429, 500])(
  'classifies Pexels HTTP %s without treating outages as invalid keys',
  async (status) => {
    vi.stubGlobal('fetch', async () => new Response(null, { status }));
    expect(
      (
        await validateServiceCredentials({
          protocol: 'pexels',
          origin: serviceCredentialOrigin('pexels'),
          credentials: { apiKey: 'test-key' },
        })
      ).status,
    ).toBe(status === 401 ? 'rejected' : 'inconclusive');
  },
);

it('does not certify malformed Pexels photos or pagination', async () => {
  for (const response of [
    { photos: [], page: -1, per_page: 1, total_results: 0 },
    { photos: [{ id: 0 }], page: 1, per_page: 1, total_results: 1 },
  ]) {
    vi.stubGlobal('fetch', async () => Response.json(response));
    expect(
      (
        await validateServiceCredentials({
          protocol: 'pexels',
          origin: serviceCredentialOrigin('pexels'),
          credentials: { apiKey: 'test-key' },
        })
      ).status,
    ).toBe('inconclusive');
  }
});

it('rejects inherited service protocol names', () => {
  expect(() => Reflect.apply(serviceCredentialOrigin, undefined, ['constructor'])).toThrow(/Unknown/);
});

it('bounds the total check even when response cancellation never settles', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const timer = new AbortController();
    setTimeout(() => timer.abort(new DOMException('Deadline exceeded', 'TimeoutError')), ms);
    return timer.signal;
  });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      return new Promise<void>(() => undefined);
    },
  });
  vi.stubGlobal('fetch', async () => new Response(body, { status: 401 }));
  const pending = validateServiceCredentials(selection);
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await pending).status).toBe('inconclusive');
  expect(cancelled).toBe(true);
});

it('cancels a late response when the HTTP boundary ignores caller cancellation', async () => {
  const caller = new AbortController();
  let resolveFetch!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
  );
  const pending = validateServiceCredentials(selection, caller.signal);
  const reason = new Error('Owner cancelled');
  caller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  let cancelled!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  resolveFetch(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
  await cleanup;
});

it('keeps the selected credentials and destination while their source is changed', async () => {
  const captured = { ...selection, credentials: { apiKey: 'original-key' } };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    await held;
    expect(url.href).toBe('https://api.elevenlabs.io/v1/user');
    expect(new Headers(init.headers).get('xi-api-key')).toBe('original-key');
    return Response.json({ user_id: 'original-owner', subscription: {} });
  });
  const pending = validateServiceCredentials(captured);
  captured.credentials.apiKey = 'replacement-key';
  captured.origin = 'https://other.example';
  release();
  expect((await pending).status).toBe('valid');
});

it.each([new Uint8Array([0xff]), new TextEncoder().encode('{broken')])(
  'keeps malformed response bytes inconclusive',
  async (bytes) => {
    vi.stubGlobal('fetch', async () => new Response(bytes));
    expect((await validateServiceCredentials(selection)).status).toBe('inconclusive');
  },
);

it.each([402, 429, 500])('does not disable a Suno key for application code %s', async (code) => {
  vi.stubGlobal('fetch', async () => Response.json({ code, msg: 'Request unavailable' }));
  expect(
    (
      await validateServiceCredentials({
        protocol: 'sunoapi',
        origin: 'https://api.sunoapi.org',
        credentials: { apiKey: 'owner-key' },
      })
    ).status,
  ).toBe('inconclusive');
});

it.each([
  { protocol: 'cartesia', origin: 'https://api.cartesia.ai', credentials: { apiKey: 'owner-key' } },
  { ...selection, credentials: { apiKey: 'key\ninvalid-header' } },
] satisfies ServiceCredentialSelection[])(
  'rejects incomplete request configuration before network access: $protocol',
  async (value) => {
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      requests.push(args);
      return Response.json({});
    });
    expect((await validateServiceCredentials(value)).status).toBe('inconclusive');
    expect(requests).toEqual([]);
  },
);

const fixtures = [
  {
    protocol: 'deepgram',
    origin: 'https://api.deepgram.com',
    path: '/v1/projects',
    header: 'authorization',
    auth: 'Token owner-key',
    body: { projects: [] },
  },
  {
    protocol: 'speechmatics',
    origin: 'https://eu1.asr.api.speechmatics.com',
    path: '/v2/jobs?limit=1',
    header: 'authorization',
    auth: 'Bearer owner-key',
    body: { jobs: [] },
  },
  {
    protocol: 'rime',
    origin: 'https://users.rime.ai',
    path: '/oov',
    header: 'authorization',
    auth: 'Bearer owner-key',
    body: [],
  },
  {
    protocol: 'elevenlabs',
    origin: 'https://api.elevenlabs.io',
    path: '/v1/user',
    header: 'xi-api-key',
    auth: 'owner-key',
    body: { user_id: 'owner', subscription: {} },
  },
  {
    protocol: 'cartesia',
    origin: 'https://api.cartesia.ai',
    path: '/voices?limit=1',
    header: 'authorization',
    auth: 'Bearer owner-key',
    body: { data: [], has_more: false },
  },
  {
    protocol: 'hume',
    origin: 'https://api.hume.ai',
    path: '/v0/tts/voices?provider=CUSTOM_VOICE&page_size=1',
    header: 'x-hume-api-key',
    auth: 'owner-key',
    body: { voices_page: [], page_number: 0, page_size: 1, total_pages: 0 },
  },
  {
    protocol: 'fal',
    origin: 'https://api.fal.ai',
    path: '/v1/models/pricing?endpoint_id=fal-ai/flux/dev',
    header: 'authorization',
    auth: 'Key owner-key',
    body: {
      prices: [{ endpoint_id: 'fal-ai/flux/dev', unit_price: 0.025, unit: 'image', currency: 'USD' }],
      has_more: false,
      next_cursor: null,
    },
  },
  {
    protocol: 'replicate',
    origin: 'https://api.replicate.com',
    path: '/v1/account',
    header: 'authorization',
    auth: 'Bearer owner-key',
    body: { username: 'owner', type: 'user' },
  },
  {
    protocol: 'assemblyai',
    origin: 'https://api.assemblyai.com',
    path: '/v2/transcript?limit=1',
    header: 'authorization',
    auth: 'owner-key',
    body: { transcripts: [], page_details: { limit: 1, result_count: 0 } },
  },
  {
    protocol: 'gladia',
    origin: 'https://api.gladia.io',
    path: '/v2/pre-recorded',
    header: 'x-gladia-key',
    auth: 'owner-key',
    body: { items: [], first: 'first', current: 'current', next: null },
  },
  {
    protocol: 'playht',
    origin: 'https://api.play.ht',
    path: '/api/v2/cloned-voices',
    header: 'authorization',
    auth: 'owner-key',
    body: [],
  },
  {
    protocol: 'sunoapi',
    origin: 'https://api.sunoapi.org',
    path: '/api/v1/generate/credit',
    header: 'authorization',
    auth: 'Bearer owner-key',
    body: { code: 200, data: 0, msg: 'success' },
  },
] satisfies Array<{
  protocol: ServiceCredentialSelection['protocol'];
  origin: string;
  path: string;
  header: string;
  auth: string;
  body: unknown;
}>;

it.each(fixtures)(
  'validates the authenticated $protocol contract with the selected credentials',
  async (fixture) => {
    vi.stubEnv('PLAYHT_USER_ID', 'another-owner');
    vi.stubGlobal('fetch', async (input: URL, init: RequestInit) => {
      expect(input.href).toBe(fixture.origin + fixture.path);
      expect(init.redirect).toBe('error');
      if (fixture.protocol === 'rime') {
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ text: 'hello' });
        expect(new Headers(init.headers).get('content-type')).toBe('application/json');
      }
      const headers = new Headers(init.headers);
      expect(headers.get(fixture.header)).toBe(fixture.auth);
      if (fixture.protocol === 'playht') expect(headers.get('x-user-id')).toBe('selected-owner');
      if (fixture.protocol === 'cartesia') expect(headers.get('Cartesia-Version')).toBe('2025-04-16');
      return Response.json(fixture.body);
    });
    expect(
      await validateServiceCredentials({
        ...fixture,
        credentials: { apiKey: 'owner-key', userId: 'selected-owner' },
        apiVersion: '2025-04-16',
      }),
    ).toMatchObject({ status: 'valid', readiness: { code: 'ready' } });
  },
);

it.each([401, 403, 429, 500, 503])(
  'distinguishes HTTP %s from definitive credential rejection',
  async (status) => {
    vi.stubGlobal('fetch', async () => new Response('private error body', { status }));
    expect((await validateServiceCredentials(selection)).status).toBe(
      status === 401 ? 'rejected' : 'inconclusive',
    );
  },
);

it.each([{}, [], { user_id: 'owner' }, '<html>Login</html>'])(
  'does not certify unknown successful payloads: %j',
  async (body) => {
    vi.stubGlobal('fetch', async () => Response.json(body));
    expect((await validateServiceCredentials(selection)).status).toBe('inconclusive');
  },
);

it('accepts additional vendor fields without requiring them for authentication proof', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ user_id: 'owner', subscription: {}, new_field: true }));
  expect((await validateServiceCredentials(selection)).status).toBe('valid');
});

it.each([
  'https://custom.example',
  'https://owner:key@api.elevenlabs.io',
  'https://api.elevenlabs.io/private',
  'invalid',
])('does not send credentials to an unsupported destination: %s', async (origin) => {
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', async (...args: unknown[]) => {
    requests.push(args);
    return Response.json({ user_id: 'owner', subscription: {} });
  });
  expect((await validateServiceCredentials({ ...selection, origin })).status).toBe('inconclusive');
  expect(requests).toEqual([]);
});

it('never borrows a platform user ID to validate a personal PlayHT key', async () => {
  vi.stubEnv('PLAYHT_USER_ID', 'platform-owner');
  const requests: unknown[] = [];
  vi.stubGlobal('fetch', async (...args: unknown[]) => {
    requests.push(args);
    return Response.json([]);
  });
  expect(
    (
      await validateServiceCredentials({
        protocol: 'playht',
        origin: 'https://api.play.ht',
        credentials: { apiKey: 'owner-key' },
      })
    ).status,
  ).toBe('missing');
  expect(requests).toEqual([]);
});

it('classifies Suno application rejection inside HTTP success', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ code: 401, msg: 'Unauthorized' }));
  expect(
    (
      await validateServiceCredentials({
        protocol: 'sunoapi',
        origin: 'https://api.sunoapi.org',
        credentials: { apiKey: 'owner-key' },
      })
    ).status,
  ).toBe('rejected');
});

it('keeps oversized account responses inconclusive and cancels their streams', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(65 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  vi.stubGlobal('fetch', async () => new Response(body, { headers: { 'content-length': '1' } }));
  expect((await validateServiceCredentials(selection)).status).toBe('inconclusive');
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

it('preserves caller cancellation while response cleanup is stalled', async () => {
  const caller = new AbortController();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    pull() {
      started();
    },
    cancel() {
      return new Promise<void>(() => undefined);
    },
  });
  vi.stubGlobal('fetch', async () => new Response(body));
  const pending = validateServiceCredentials(selection, caller.signal);
  await reading;
  const reason = new Error('Owner cancelled');
  caller.abort(reason);
  await expect(pending).rejects.toBe(reason);
});
