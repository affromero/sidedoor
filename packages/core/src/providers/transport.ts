import { abortable } from '../runtime/abort';

export interface ProviderRequestRule {
  method: string;
  url: string;
  /** Match descendants of a path ending in '/', for example authenticated polling IDs. */
  descendants?: boolean;
  allowQuery?: boolean;
}

export interface ProviderRequestAdmission {
  readonly url: string;
  readonly method: string;
}

export interface ProviderResponseConsumption {
  readonly status: number;
}

export interface ProviderTransport {
  authenticatedFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    observation?: {
      /** Transport invocation is beginning; this does not prove bytes reached the provider. */
      onDispatch: () => void;
      /** The complete HTTP response body was consumed. The provider decides whether this is terminal. */
      onConsumed?: (response: ProviderResponseConsumption) => void;
    },
  ) => ReturnType<typeof fetch>;
}

function endpoint(value: string) {
  if (!URL.canParse(value)) throw new Error('Invalid provider request destination');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error('Invalid provider request destination');
  return url;
}

async function cancelBody(body: ReadableStream<Uint8Array> | null) {
  if (body && !body.locked) await abortable(body.cancel(), AbortSignal.timeout(1_000));
}

function observeResponseConsumption(
  response: Response,
  onConsumed?: (response: ProviderResponseConsumption) => void,
): Response {
  if (!onConsumed) return response;
  const consumption = Object.freeze({ status: response.status });
  if (!response.body) {
    onConsumed(consumption);
    return response;
  }
  const reader = response.body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          onConsumed(consumption);
          release();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await abortable(reader.cancel(reason), AbortSignal.timeout(1_000));
      } finally {
        release();
      }
    },
  });
  const observed = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(observed, {
    redirected: { configurable: true, value: response.redirected },
    type: { configurable: true, value: response.type },
    url: { configurable: true, value: response.url },
  });
  return observed;
}

/** Each actual HTTP attempt, including SDK retries, must pass its captured destination and admission policy. */
export function createProviderTransport(options: {
  rules: readonly ProviderRequestRule[];
  /** Must check cancellation before committing admission side effects. */
  admit: (request: ProviderRequestAdmission, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  implementation?: typeof fetch;
  /** Reports cleanup failures after cancellation has already returned to the caller. */
  onCleanupError?: (error: unknown) => void;
}): ProviderTransport {
  const rules = options.rules.map((rule) => {
    const url = endpoint(rule.url);
    if (rule.descendants && (!url.pathname.endsWith('/') || url.search))
      throw new Error('Provider descendant rules require a path ending in / without a query');
    return Object.freeze({
      origin: url.origin,
      path: url.pathname,
      search: url.search,
      method: rule.method.toUpperCase(),
      descendants: rule.descendants === true,
      allowQuery: rule.allowQuery === true,
    });
  });
  if (!rules.length) throw new Error('Provider transport requires a destination policy');
  const admit = options.admit;
  const lifetime = options.signal;
  const implementation = options.implementation ?? globalThis.fetch;
  const onCleanupError = options.onCleanupError;
  const authenticatedFetch: ProviderTransport['authenticatedFetch'] = async (input, init, observation) => {
    const onDispatch = observation?.onDispatch;
    const onConsumed = observation?.onConsumed;
    const request = new Request(input, init);
    const signal = lifetime ? AbortSignal.any([lifetime, request.signal]) : request.signal;
    let outgoing: Request | undefined;
    try {
      signal.throwIfAborted();
      const url = endpoint(request.url);
      const allowed = rules.some(
        (rule) =>
          rule.method === request.method &&
          rule.origin === url.origin &&
          (rule.descendants ? url.pathname.startsWith(rule.path) : url.pathname === rule.path) &&
          (rule.allowQuery || url.search === rule.search),
      );
      if (!allowed) throw new Error('Provider request is outside the captured destination policy');
      await abortable(admit(Object.freeze({ url: url.href, method: request.method }), signal), signal);
      signal.throwIfAborted();
      outgoing = new Request(request, { signal, redirect: 'error' });
      signal.throwIfAborted();
      onDispatch?.();
      signal.throwIfAborted();
      const dispatched = implementation(outgoing).then(async (response) => {
        if (signal.aborted) {
          try {
            await cancelBody(response.body);
          } catch (error) {
            onCleanupError?.(error);
          } finally {
            signal.throwIfAborted();
          }
        }
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          const error = new Error('Provider request redirected');
          try {
            await cancelBody(response.body);
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], error.message, { cause: cleanup });
          }
          throw error;
        }
        signal.throwIfAborted();
        return observeResponseConsumption(response, onConsumed);
      });
      return await abortable(dispatched, signal);
    } catch (error) {
      const body = outgoing?.body ?? request.body;
      try {
        await cancelBody(body);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Provider request and cleanup failed', { cause: cleanup });
      }
      throw error;
    }
  };
  return Object.freeze({ authenticatedFetch });
}

export interface MediaTransport {
  downloadMedia(url: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
}

/** Credential-free buffered downloads. The caller admits each destination and execution owner. */
export function createMediaTransport(options: {
  admit: (request: ProviderRequestAdmission, signal: AbortSignal) => Promise<void>;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  implementation?: typeof fetch;
  onCleanupError?: (error: unknown) => void;
}): MediaTransport {
  const { admit, maxBytes, timeoutMs, signal: lifetime, onCleanupError } = options;
  const maxRedirects = options.maxRedirects ?? 20;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('Media byte limit must be a positive safe integer');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error('Media timeout must be between 1 and 2147483647 milliseconds');
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20)
    throw new Error('Media redirect limit must be between 0 and 20');
  const implementation = options.implementation ?? globalThis.fetch;

  return Object.freeze({
    async downloadMedia(value: string, invocation?: { signal?: AbortSignal }) {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (lifetime) signals.push(lifetime);
      if (invocation?.signal) signals.push(invocation.signal);
      const signal = AbortSignal.any(signals);
      let url = endpoint(value);
      for (let hop = 0; hop <= maxRedirects; hop++) {
        signal.throwIfAborted();
        await abortable(admit(Object.freeze({ url: url.href, method: 'GET' }), signal), signal);
        signal.throwIfAborted();
        const pending = implementation(
          new Request(url, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'manual',
            signal,
          }),
        ).then(async (response) => {
          if (signal.aborted) {
            try {
              await cancelBody(response.body);
            } catch (error) {
              onCleanupError?.(error);
            }
            signal.throwIfAborted();
          }
          return response;
        });
        const response = await abortable(pending, signal);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          signal.throwIfAborted();
          if (response.redirected) throw new Error('Media transport followed an unadmitted redirect');
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (hop === maxRedirects) throw new Error('Media redirect limit exceeded');
            const location = response.headers.get('location');
            if (!location || !URL.canParse(location, url)) throw new Error('Invalid media redirect');
            url = endpoint(new URL(location, url).href);
            await cancelBody(response.body);
            continue;
          }
          if (!response.ok) throw new Error(`Media download failed (${response.status})`);
          if (!response.body) return new Uint8Array();
          reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let length = 0;
          while (true) {
            const chunk = await abortable(reader.read(), signal);
            signal.throwIfAborted();
            if (chunk.done) break;
            if (chunk.value.byteLength > maxBytes - length) throw new Error('Media byte limit exceeded');
            length += chunk.value.byteLength;
            chunks.push(chunk.value.slice());
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return bytes;
        } catch (error) {
          try {
            if (reader) await abortable(reader.cancel(), AbortSignal.timeout(1_000));
            else await cancelBody(response.body);
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], 'Media download and cleanup failed', {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          reader?.releaseLock();
        }
      }
      throw new Error('Media redirect limit exceeded');
    },
  });
}
