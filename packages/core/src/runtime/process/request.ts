export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super('Request body exceeds the allowed size');
    this.name = 'RequestBodyTooLargeError';
  }
}

/** Count actual bytes before parsing. A claimed Content-Length never bypasses this bound. */
export async function readRequestBytes(
  request: Pick<Request, 'body' | 'signal'>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid request body limit');
  request.signal.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let cancellation: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;
  let bytes = new Uint8Array();
  const abort = () => {
    cancellation ??= reader.cancel(request.signal.reason);
    // Observe immediately; cleanup awaits it while preserving any primary read failure.
    void cancellation.catch(() => undefined);
  };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      request.signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) throw new RequestBodyTooLargeError(maxBytes);
      chunks.push(chunk.value);
    }
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch (error) {
    failure = { error };
  }
  request.signal.removeEventListener('abort', abort);
  try {
    await (cancellation ?? reader.cancel());
  } catch (error) {
    failure ??= { error };
  } finally {
    reader.releaseLock();
  }
  if (failure) throw failure.error;
  return bytes;
}
