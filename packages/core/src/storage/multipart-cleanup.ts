import { validateStorageKey } from './references';

export interface MultipartCleanupPage {
  entries: ReadonlyArray<{ key: string | undefined; uploadId: string | undefined }>;
  isTruncated: boolean;
  nextKey?: string;
  nextUploadId?: string;
}

export interface MultipartCleanupPort {
  listMultipart(
    prefix: string,
    keyMarker: string | undefined,
    uploadIdMarker: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MultipartCleanupPage>;
  /** Already absent is success. Every other service failure must propagate. */
  abortMultipart(key: string, uploadId: string, signal?: AbortSignal): Promise<void>;
}

/** Caller retains the key target, exclusive backend ownership, and resolved/stopped writer evidence. */
export class MultipartStorageCleanup {
  constructor(
    private readonly port: MultipartCleanupPort,
    private readonly maxDeletePages: number,
  ) {}

  async *list(prefix: string, signal?: AbortSignal): AsyncGenerator<{ key: string; uploadId: string }> {
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    const seen = new Set<string>();
    do {
      signal?.throwIfAborted();
      const page = await this.port.listMultipart(prefix, keyMarker, uploadIdMarker, 1000, signal);
      signal?.throwIfAborted();
      for (const entry of page.entries) {
        if (!entry.key || !entry.key.startsWith(prefix))
          throw new Error('Multipart listing returned a key outside the cleanup prefix');
        validateStorageKey(entry.key.endsWith('/') ? entry.key.slice(0, -1) : entry.key);
        if (
          !entry.uploadId ||
          [...entry.uploadId].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        )
          throw new Error('Multipart listing returned an invalid upload identity');
        yield { key: entry.key, uploadId: entry.uploadId };
      }
      if (!page.isTruncated) return;
      keyMarker = page.nextKey;
      uploadIdMarker = page.nextUploadId;
      const marker = JSON.stringify([keyMarker, uploadIdMarker]);
      if (!keyMarker || !uploadIdMarker || seen.has(marker))
        throw new Error('Multipart listing did not advance');
      seen.add(marker);
    } while (keyMarker);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    let previous: string | undefined;
    for (let batch = 0; batch < this.maxDeletePages; batch++) {
      const uploads: Array<{ key: string; uploadId: string }> = [];
      for await (const entry of this.list(key, signal)) {
        if (entry.key !== key) continue;
        uploads.push(entry);
        if (uploads.length === 1000) break;
      }
      if (!uploads.length) return;
      const signature = JSON.stringify(uploads.map((entry) => entry.uploadId).sort());
      if (signature === previous) throw new Error('Multipart deletion did not advance');
      previous = signature;
      // Discovery iterator has closed. Restart on the next batch instead of using deleted markers.
      for (const upload of uploads) {
        signal?.throwIfAborted();
        await this.port.abortMultipart(key, upload.uploadId, signal);
        signal?.throwIfAborted();
      }
    }
    throw new Error('Multipart cleanup reached its batch limit; retry to continue');
  }
}
