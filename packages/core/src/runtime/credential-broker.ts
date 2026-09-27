import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { z } from 'zod';
import { abortable } from './process/abort';
export { isolatedClaudeRelay } from './isolated-claude-relay';

const textBlock = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    cache_control: z
      .object({ type: z.literal('ephemeral') })
      .strict()
      .optional(),
  })
  .strict();
const anthropicBody = z
  .object({
    model: z.string(),
    max_tokens: z.number().int().positive(),
    messages: z
      .array(
        z
          .object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(textBlock)]) })
          .strict(),
      )
      .min(1)
      .max(512),
    system: z.union([z.string(), z.array(textBlock)]).optional(),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop_sequences: z.array(z.string().max(200)).max(10).optional(),
    tools: z.array(z.never()).max(0).optional(),
    metadata: z
      .object({ user_id: z.string().max(1024) })
      .strict()
      .optional(),
    thinking: z
      .object({ type: z.literal('disabled') })
      .strict()
      .optional(),
    output_config: z
      .object({ effort: z.enum(['low', 'medium', 'high', 'max']) })
      .strict()
      .optional(),
  })
  .strict();
const chatBody = z
  .object({
    model: z.string(),
    max_tokens: z.number().int().positive(),
    messages: z
      .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict())
      .min(1)
      .max(512),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
  })
  .strict();

export interface CredentialBrokerOptions {
  executionId: string;
  protocol: 'anthropic-messages' | 'openai-chat';
  /** Exact HTTPS provider endpoint, selected by trusted application configuration. */
  endpoint: string;
  model: string;
  credential: string;
  expiresAt: number;
  maxOutputTokens: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
  signal?: AbortSignal;
  /** Must atomically reserve an attempt and revalidate authority. Throw to deny. */
  admit(request: {
    executionId: string;
    model: string;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<void>;
  /** Trusted provider transport, allowing applications to retain credential admission. */
  fetch?: typeof globalThis.fetch;
}
export interface CredentialBroker {
  directory: string;
  socketPath: string;
  /** Execution-scoped capability only. Never the provider credential. */
  token: string;
  close(): Promise<void>;
}

export class CredentialBrokerCleanupError extends Error {
  constructor() {
    super('Credential broker cleanup could not be verified');
    this.name = 'CredentialBrokerCleanupError';
  }
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization;
  if (typeof supplied !== 'string') return false;
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function reject(response: ServerResponse, status: number): void {
  if (response.headersSent) response.destroy();
  else {
    response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify({ error: 'broker_request_rejected' }));
  }
}

/** Parent-owned Unix socket. Only normalized text-generation requests can leave it. */
export async function startCredentialBroker(options: CredentialBrokerOptions): Promise<CredentialBroker> {
  options = { ...options };
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new TypeError('Broker requires a fixed HTTPS endpoint');
  const route = options.protocol === 'anthropic-messages' ? '/v1/messages' : '/v1/chat/completions';
  if (!endpoint.pathname.endsWith(route)) throw new TypeError('Endpoint does not match broker protocol');
  if (!options.model || !options.credential || !options.executionId)
    throw new TypeError('Broker identity and credential are required');
  for (const value of [
    options.maxOutputTokens,
    options.maxRequestBytes,
    options.maxResponseBytes,
    options.maxConcurrentRequests,
    options.requestTimeoutMs,
    options.expiresAt,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError('Positive integer broker limits required');
  }
  if (options.expiresAt <= Date.now()) throw new Error('Broker grant expired');
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'sidedoor-broker-'));
  const socketPath = join(directory, 'broker.sock');
  const token = randomBytes(32).toString('hex');
  const lifetime = new AbortController();
  let active = 0;
  const pending = new Set<Promise<void>>();
  let cleanupFailed = false;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (lifetime.signal.aborted || Date.now() >= options.expiresAt) return reject(response, 403);
    if (!authorized(request, token)) return reject(response, 401);
    if (
      request.method !== 'POST' ||
      request.url !== route ||
      request.headers['content-type']?.split(';')[0] !== 'application/json'
    )
      return reject(response, 400);
    const allowed = new Set([
      'host',
      'connection',
      'content-type',
      'content-length',
      'transfer-encoding',
      'authorization',
    ]);
    if (Object.keys(request.headers).some((header) => !allowed.has(header))) return reject(response, 400);
    if (active >= options.maxConcurrentRequests) return reject(response, 429);
    active++;
    const disconnected = new AbortController();
    const timeout = AbortSignal.timeout(
      Math.min(options.requestTimeoutMs, Math.max(1, options.expiresAt - Date.now())),
    );
    const signal = AbortSignal.any([lifetime.signal, disconnected.signal, timeout]);
    const disconnect = () => disconnected.abort();
    response.on('close', disconnect);
    const abort = () => {
      request.destroy();
      response.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    let upstream: Response | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const raw of request) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        size += chunk.byteLength;
        if (size > options.maxRequestBytes) return reject(response, 413);
        chunks.push(chunk);
      }
      const parsed = (options.protocol === 'anthropic-messages' ? anthropicBody : chatBody).safeParse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (
        !parsed.success ||
        parsed.data.model !== options.model ||
        parsed.data.max_tokens > options.maxOutputTokens
      )
        return reject(response, 400);
      signal.throwIfAborted();
      await abortable(
        options.admit({
          executionId: options.executionId,
          model: options.model,
          maxOutputTokens: parsed.data.max_tokens,
          signal,
        }),
        signal,
      );
      signal.throwIfAborted();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.protocol === 'anthropic-messages') {
        headers['x-api-key'] = options.credential;
        headers['anthropic-version'] = '2023-06-01';
      } else headers.authorization = `Bearer ${options.credential}`;
      upstream = await (options.fetch ?? globalThis.fetch)(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(parsed.data),
        redirect: 'error',
        signal,
      });
      signal.throwIfAborted();
      // Provider diagnostics may contain credential material. Never forward error bodies or headers.
      if (!upstream.ok) return reject(response, 502);
      const type = upstream.headers.get('content-type')?.split(';')[0];
      if (type !== 'application/json' && type !== 'text/event-stream') return reject(response, 502);
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      if (upstream.body) {
        let received = 0;
        for await (const chunk of upstream.body) {
          signal.throwIfAborted();
          received += chunk.byteLength;
          if (received > options.maxResponseBytes) throw new Error('Response limit');
          if (!response.write(chunk)) await once(response, 'drain', { signal });
        }
      }
      response.end();
    } catch {
      reject(response, signal.aborted ? 408 : 403);
    } finally {
      signal.removeEventListener('abort', abort);
      disconnected.abort();
      response.removeListener('close', disconnect);
      if (upstream?.body && !upstream.body.locked)
        await upstream.body.cancel().catch(() => {
          cleanupFailed = true;
        });
      active--;
    }
  }
  const server = createServer((request, response) => {
    const task = handle(request, response);
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => response.destroy());
  });
  server.requestTimeout = options.requestTimeoutMs;
  server.headersTimeout = Math.min(10_000, options.requestTimeoutMs);
  server.maxHeadersCount = 16;
  server.maxConnections = options.maxConcurrentRequests + 8;
  server.on('connection', (socket) => socket.setTimeout(options.requestTimeoutMs, () => socket.destroy()));
  server.on('clientError', (_error, socket) => socket.destroy());
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      lifetime.abort();
      options.signal?.removeEventListener('abort', onAbort);
      clearTimeout(expiry);
      server.closeAllConnections();
      await new Promise<void>((resolve, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolve())),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise<never>((_resolve, rejectPending) => {
            timer = setTimeout(() => rejectPending(new CredentialBrokerCleanupError()), 1000);
          }),
        ]);
        if (cleanupFailed) throw new CredentialBrokerCleanupError();
      } finally {
        clearTimeout(timer);
        await rm(directory, { recursive: true, force: true });
      }
    })().catch(() => {
      throw new CredentialBrokerCleanupError();
    }));
  const onAbort = () => {
    void close().catch(() => undefined);
  };
  const expiry = setTimeout(onAbort, Math.min(2_147_483_647, options.expiresAt - Date.now()));
  expiry.unref();
  try {
    server.listen(socketPath);
    await once(server, 'listening');
    // An unguessable directory and execution token restrict the mounted socket;
    // the container UID differs from the parent UID.
    await chmod(directory, 0o711);
    await chmod(socketPath, 0o666);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      await close();
      options.signal.throwIfAborted();
    }
    return { directory, socketPath, token, close };
  } catch (error) {
    await close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
