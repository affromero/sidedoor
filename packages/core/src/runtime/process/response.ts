import { abortable } from './abort';

export class ResponseBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super('Response body exceeds the allowed size');
    this.name = 'ResponseBodyTooLargeError';
  }
}

async function cancelFailedRead(cancel: () => Promise<void>, error: unknown): Promise<never> {
  let cleanupFailure: { error: unknown } | undefined;
  try {
    await abortable(cancel(), AbortSignal.timeout(1_000));
  } catch (cleanup) {
    cleanupFailure = { error: cleanup };
  }
  if (cleanupFailure)
    throw new AggregateError([error, cleanupFailure.error], 'Response read and cleanup failed', {
      cause: error,
    });
  throw error;
}

async function consumeResponse<Result>(
  response: Pick<Response, 'body'>,
  options: { signal: AbortSignal; maxBytes: number },
  append: (chunk: Uint8Array) => void,
  finish: () => Result,
): Promise<Result> {
  const { signal, maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid response body limit');
  if (signal.aborted)
    return cancelFailedRead(() => response.body?.cancel(signal.reason) ?? Promise.resolve(), signal.reason);
  const reader = response.body?.getReader();
  if (!reader) return finish();
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (chunk.done) break;
      if (chunk.value.byteLength > maxBytes - length) throw new ResponseBodyTooLargeError(maxBytes);
      length += chunk.value.byteLength;
      append(chunk.value);
    }
    return finish();
  } catch (error) {
    return await cancelFailedRead(() => reader.cancel(error), error);
  } finally {
    reader.releaseLock();
  }
}

/** The caller combines cancellation and its total request deadline in signal. */
export function readResponseText(
  response: Pick<Response, 'body'>,
  options: { signal: AbortSignal; maxBytes: number },
): Promise<string> {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  return consumeResponse(
    response,
    options,
    (chunk) => parts.push(decoder.decode(chunk, { stream: true })),
    () => {
      parts.push(decoder.decode());
      return parts.join('');
    },
  );
}

/** Owned binary response read. The caller selects a bound supported by its allocation/runtime policy. */
export function readResponseBytes(
  response: Pick<Response, 'body'>,
  options: { signal: AbortSignal; maxBytes: number },
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  return consumeResponse(
    response,
    options,
    (chunk) => {
      chunks.push(Uint8Array.from(chunk));
      length += chunk.byteLength;
    },
    () => {
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    },
  );
}
