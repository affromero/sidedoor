import {
  normalizeStorageReference,
  storageBackendBinding,
  validateStorageKey,
  type StorageBackendLocation,
} from '../../registry/references';
import { MultipartStorageCleanup, type MultipartCleanupPort } from './multipart-cleanup';

export interface ObjectCleanupPage {
  entries: ReadonlyArray<{ key: string | undefined }>;
  isTruncated: boolean;
  nextToken?: string;
}
export interface ObjectVersionCleanupPage {
  /** Includes deletion markers. Entries use the service's lexicographic prefix ordering. */
  entries: ReadonlyArray<{ key: string | undefined; versionId: string | undefined }>;
  isTruncated: boolean;
  nextKey?: string;
  nextVersion?: string;
}
export type ObjectCleanupPort =
  | {
      kind: 'unversioned';
      listObjects(
        prefix: string,
        token: string | undefined,
        limit: number,
        signal?: AbortSignal,
      ): Promise<ObjectCleanupPage>;
      deleteObject(key: string, signal?: AbortSignal): Promise<void>;
    }
  | {
      kind: 'versioned';
      listVersions(
        prefix: string,
        keyMarker: string | undefined,
        versionMarker: string | undefined,
        limit: number,
        signal?: AbortSignal,
      ): Promise<ObjectVersionCleanupPage>;
      deleteVersion(key: string, versionId: string, signal?: AbortSignal): Promise<void>;
    };

function objectKey(value: string): string {
  // Object stores may contain explicit directory markers. Preserve their final slash exactly.
  validateStorageKey(value.endsWith('/') ? value.slice(0, -1) : value);
  return value;
}

/** The injected port must already address the captured location. Core never selects credentials or endpoints. */
export class ObjectStorageCleanup {
  readonly location: Readonly<Extract<StorageBackendLocation, { kind: 'object' }>>;
  readonly binding: string;
  readonly publicUrl: string | null;
  readonly publicUrlEncoding: 'raw' | 'percent';
  private readonly port: ObjectCleanupPort;
  private readonly maxDeletePages: number;
  private readonly multipart: MultipartStorageCleanup;
  private activeListings = 0;
  private activeDeletions = 0;

  constructor(options: {
    location: Extract<StorageBackendLocation, { kind: 'object' }>;
    publicUrl?: string | null;
    publicUrlEncoding?: 'raw' | 'percent';
    port: ObjectCleanupPort;
    multipart: MultipartCleanupPort;
    maxDeletePages?: number;
  }) {
    this.location = Object.freeze({ ...options.location });
    this.binding = storageBackendBinding(this.location);
    this.publicUrl = options.publicUrl ?? null;
    this.publicUrlEncoding = options.publicUrlEncoding ?? 'raw';
    this.port = options.port;
    this.maxDeletePages = options.maxDeletePages ?? 100;
    if (!Number.isSafeInteger(this.maxDeletePages) || this.maxDeletePages < 1 || this.maxDeletePages > 1000)
      throw new Error('Cleanup batch limit must be between 1 and 1000');
    if (
      !options.multipart ||
      typeof options.multipart.listMultipart !== 'function' ||
      typeof options.multipart.abortMultipart !== 'function'
    )
      throw new Error('Object cleanup requires multipart inventory and abort support');
    this.multipart = new MultipartStorageCleanup(options.multipart, this.maxDeletePages);
    if (this.publicUrl) this.normalize(`${this.publicUrl.replace(/\/$/, '')}/__reference_validation__`);
  }

  normalize(reference: string): string {
    return normalizeStorageReference(this.location, reference, {
      ...(this.publicUrl ? { publicUrl: this.publicUrl } : {}),
      publicUrlEncoding: this.publicUrlEncoding,
    });
  }

  /** Finish and persist discovery before deleting. Separate instances require caller coordination. */
  async *list(prefix: string, signal?: AbortSignal): AsyncGenerator<string> {
    if (this.activeDeletions) throw new Error('Finish deleting before collecting another cleanup manifest');
    this.activeListings++;
    try {
      if (!prefix.endsWith('/')) throw new Error('Cleanup requires an exact directory prefix');
      validateStorageKey(prefix.slice(0, -1));
      yield* this.scan(prefix, signal);
      for await (const upload of this.multipart.list(prefix, signal)) yield upload.key;
    } finally {
      this.activeListings--;
    }
  }

  /** Exact-key verification includes retained versions and deletion markers, even without a live object. */
  async has(key: string, signal?: AbortSignal): Promise<boolean> {
    objectKey(key);
    if (this.activeDeletions) throw new Error('Finish deleting before collecting another cleanup manifest');
    this.activeListings++;
    try {
      for await (const candidate of this.scan(key, signal)) if (candidate === key) return true;
      for await (const upload of this.multipart.list(key, signal)) if (upload.key === key) return true;
      return false;
    } finally {
      this.activeListings--;
    }
  }

  private async *scan(prefix: string, signal?: AbortSignal): AsyncGenerator<string> {
    if (this.port.kind === 'versioned') {
      yield* this.listVersions(this.port, prefix, signal);
      return;
    }
    let token: string | undefined;
    const seen = new Set<string>();
    while (true) {
      signal?.throwIfAborted();
      const page = await this.port.listObjects(prefix, token, 1000, signal);
      signal?.throwIfAborted();
      for (const entry of page.entries) yield this.listedKey(entry.key, prefix);
      if (!page.isTruncated) return;
      token = page.nextToken;
      if (!token || seen.has(token)) throw new Error('Storage listing did not advance');
      seen.add(token);
    }
  }

  private listedKey(key: string | undefined, prefix: string): string {
    if (!key || !key.startsWith(prefix))
      throw new Error('Storage listing returned an object outside the cleanup prefix');
    return objectKey(key);
  }

  private async *listVersions(
    port: Extract<ObjectCleanupPort, { kind: 'versioned' }>,
    prefix: string,
    signal?: AbortSignal,
  ) {
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    const seen = new Set<string>();
    while (true) {
      signal?.throwIfAborted();
      const page = await port.listVersions(prefix, keyMarker, versionMarker, 1000, signal);
      signal?.throwIfAborted();
      for (const entry of page.entries) {
        if (!entry.versionId) throw new Error('Storage version listing is incomplete');
        yield this.listedKey(entry.key, prefix);
      }
      if (!page.isTruncated) return;
      keyMarker = page.nextKey;
      versionMarker = page.nextVersion;
      const marker = JSON.stringify([keyMarker, versionMarker]);
      if (!keyMarker || seen.has(marker)) throw new Error('Storage version listing did not advance');
      seen.add(marker);
    }
  }

  /** Caller establishes ownership and drains writers before invoking deletion. */
  async delete(key: string, signal?: AbortSignal): Promise<void> {
    if (this.activeListings) throw new Error('Finish collecting the cleanup manifest before deleting');
    this.activeDeletions++;
    try {
      await this.deleteExact(key, signal);
    } finally {
      this.activeDeletions--;
    }
  }

  private async deleteExact(key: string, signal?: AbortSignal): Promise<void> {
    objectKey(key);
    await this.multipart.delete(key, signal);
    signal?.throwIfAborted();
    if (this.port.kind === 'unversioned') {
      await this.port.deleteObject(key, signal);
      signal?.throwIfAborted();
      return;
    }
    let previous: string | undefined;
    for (let pageNumber = 0; pageNumber < this.maxDeletePages; pageNumber++) {
      // Restart after deletion so no continuation depends on a removed version marker.
      signal?.throwIfAborted();
      const page = await this.port.listVersions(key, undefined, undefined, 1000, signal);
      signal?.throwIfAborted();
      for (const entry of page.entries) {
        this.listedKey(entry.key, key);
        if (!entry.versionId) throw new Error('Storage version listing is incomplete');
      }
      if (!page.entries.length && page.isTruncated)
        throw new Error('Storage version listing did not advance');
      const versions = page.entries.filter((entry) => entry.key === key);
      if (!versions.length) return;
      const signature = JSON.stringify(versions.map((entry) => entry.versionId).sort());
      if (signature === previous) throw new Error('Storage version deletion did not advance');
      previous = signature;
      for (const version of versions) {
        signal?.throwIfAborted();
        await this.port.deleteVersion(key, version.versionId!, signal);
        signal?.throwIfAborted();
      }
    }
    throw new Error('Storage version cleanup reached its batch limit; retry to continue');
  }
}
