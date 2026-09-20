import { describe, expect, it } from 'vitest';
import { readRequestBytes, RequestBodyTooLargeError } from '../src/runtime/request';

function request(body: ReadableStream<Uint8Array>, signal?: AbortSignal, length?: string) {
  return new Request('https://app.example/upload', {
    method: 'POST',
    body,
    signal,
    headers: length ? { 'content-length': length } : {},
    ...{ duplex: 'half' },
  });
}
describe('bounded request bytes', () => {
  it('preserves the body limit error when upstream cancellation also fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        throw new Error('Upstream cancellation failed');
      },
    });
    await expect(readRequestBytes(request(body), 4)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(body.locked).toBe(false);
  });
  it('preserves exact bytes across chunks up to the limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 255]));
        controller.enqueue(new Uint8Array([4]));
        controller.close();
      },
    });
    expect(await readRequestBytes(request(body), 3)).toEqual(new Uint8Array([0, 255, 4]));
    expect(body.locked).toBe(false);
  });
  it('cancels over-limit bodies despite a false Content-Length and releases the stream', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readRequestBytes(request(body, undefined, '1'), 4)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
  it('cancels a stalled read when the request is aborted', async () => {
    const abort = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const reading = readRequestBytes(request(body, abort.signal), 4);
    abort.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
  it('rejects invalid limits without consuming the request', async () => {
    const value = new Request('https://app.example', { method: 'POST', body: 'text' });
    await expect(readRequestBytes(value, -1)).rejects.toThrow('Invalid request body limit');
    expect(value.bodyUsed).toBe(false);
  });
});
