import { afterEach, expect, it, vi } from 'vitest';
import { createSelectedApiRegistry } from '../../src/ai/configuration/providers';
import { createGoogleProvider } from '../../src/ai/providers/google';
import { ProviderRegistry, type ProviderDescriptor } from '../../src/ai';

const descriptor: ProviderDescriptor = {
  id: 'proof',
  label: 'Proof',
  transport: 'api',
  fields: [],
  models: [],
  capabilities: ['text'],
};
const page = { object: 'list', data: [] };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function registry(endpoint = 'https://api.openai.com/v1') {
  return createSelectedApiRegistry(
    {
      transport: 'compatible',
      descriptor,
      credentials: { apiKey: 'selected-key' },
      baseUrl: endpoint,
      requiresKey: true,
    },
    { maxRetries: 0 },
  );
}

it.each([
  'https://api.openai.com/v1',
  'https://generativelanguage.googleapis.com/v1beta/openai',
  'https://api.groq.com/openai/v1',
  'https://api.x.ai/v1',
  'https://api.deepseek.com',
  'https://api.deepseek.com/v1',
  'https://api.mistral.ai/v1',
])('certifies the documented authenticated model-list contract at %s', async (endpoint) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(`${endpoint}/models`);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-key');
    return Response.json(page);
  });
  expect(await registry(endpoint).validateCredentials('proof')).toMatchObject({
    status: 'valid',
    readiness: { code: 'ready', authentication: 'verified' },
  });
});

it.each([
  'https://integrate.api.nvidia.com/v1',
  'https://custom.example/v1',
  'https://api.openai.com/custom',
])('keeps catalog reachability separate from authentication at %s', async (endpoint) => {
  vi.stubGlobal('fetch', async () => Response.json(page));
  const validation = await registry(endpoint).validateCredentials('proof');
  expect(validation).toMatchObject({ status: 'inconclusive', readiness: { code: 'ready' } });
  expect(validation.readiness.authentication).toBeUndefined();
});

it.each([
  {},
  { object: 'list' },
  { object: 'list', data: [{}] },
  { object: 'list', data: [{ id: '' }] },
  '<html>Login</html>',
])('does not certify malformed successful SDK payloads: %j', async (body) => {
  vi.stubGlobal('fetch', async () => Response.json(body));
  expect((await registry().validateCredentials('proof')).status).toBe('inconclusive');
});

it('requires Anthropic raw pagination fields instead of SDK page defaults', async () => {
  const selected = createSelectedApiRegistry(
    { transport: 'anthropic', descriptor, credentials: { apiKey: 'selected-key' } },
    { maxRetries: 0 },
  );
  vi.stubGlobal('fetch', async () => Response.json({ data: [] }));
  expect((await selected.validateCredentials('proof')).status).toBe('inconclusive');
  vi.stubGlobal('fetch', async () =>
    Response.json({ data: [], has_more: false, first_id: null, last_id: null }),
  );
  expect((await selected.validateCredentials('proof')).status).toBe('valid');
});

it('cancels oversized SDK error responses without classifying their keys as rejected', async () => {
  let cancelled = false;
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(65 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 401 },
      ),
  );
  expect((await registry().validateCredentials('proof')).status).toBe('inconclusive');
  expect(cancelled).toBe(true);
});

it.each([{ models: [] }, {}, { models: [{}] }])(
  'validates native Google raw model schema: %j',
  async (body) => {
    const selected = new ProviderRegistry({
      providers: [createGoogleProvider(descriptor)],
      credentials: {
        async resolve() {
          return { apiKey: 'google-key' };
        },
      },
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('google-key');
      expect(init?.redirect).toBe('error');
      return Response.json(body);
    });
    const valid = 'models' in body && body.models?.length === 0;
    expect((await selected.validateCredentials('proof')).status).toBe(valid ? 'valid' : 'inconclusive');
  },
);

it('preserves cancellation during raw SDK response reading', async () => {
  const caller = new AbortController();
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let cancelled = false;
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            reading();
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const pending = registry().validateCredentials('proof', caller.signal);
  await started;
  const reason = new Error('Owner cancelled');
  caller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(cancelled).toBe(true);
});

it('cancels a response arriving after the owner has cancelled the probe', async () => {
  const caller = new AbortController();
  let started!: () => void;
  const startedRequest = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', () => {
    started();
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const pending = registry().validateCredentials('proof', caller.signal);
  await startedRequest;
  const reason = new Error('Owner cancelled');
  caller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  let cancelled!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  finish(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })));
  await cleanup;
});

it('refuses proof from an HTTP implementation that has already followed a redirect', async () => {
  vi.stubGlobal('fetch', async () => {
    const response = Response.json(page);
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  });
  expect((await registry().validateCredentials('proof')).status).toBe('inconclusive');
});

it('bounds a stalled SDK body cancellation by the credential check deadline', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError')), ms);
    return deadline.signal;
  });
  let cancelled = false;
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(65 * 1024));
          },
          cancel() {
            cancelled = true;
            return new Promise<void>(() => undefined);
          },
        }),
      ),
  );
  const pending = registry().validateCredentials('proof');
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await pending).status).toBe('inconclusive');
  expect(cancelled).toBe(true);
});
