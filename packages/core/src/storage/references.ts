import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type StorageBackendLocation =
  { kind: 'local'; root: string } | { kind: 'object'; endpoint: string; bucket: string };

export interface StorageReferenceOptions {
  localRoutePrefix?: string;
  publicUrl?: string;
  /** Select the encoding used by the application when it creates public object URLs. */
  publicUrlEncoding?: 'raw' | 'percent';
}

export class StorageReferenceError extends Error {
  constructor() {
    super('Storage reference does not identify an object in the selected backend');
    this.name = 'StorageReferenceError';
  }
}

function reject(): never {
  throw new StorageReferenceError();
}

function hasControl(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Validate an exact raw key without interpreting it as a URL or decoding percent signs. */
export function validateStorageKey(value: string): string {
  if (
    !value ||
    value.includes('\\') ||
    hasControl(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    reject();
  return value;
}

function decodedPath(value: string): string {
  return value
    .split('/')
    .map((part) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(part);
      } catch {
        return reject();
      }
      if (decoded.includes('/')) reject();
      return validateStorageKey(decoded);
    })
    .join('/');
}

function httpLocation(value: string, rawKey = false): { url: URL; path: string } {
  // Inspect the original path before URL parsing can erase traversal segments.
  const match = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?$/.exec(value);
  if (!match || value.includes('\\') || hasControl(value)) reject();
  const path = match[2] || '';
  if (path && path !== '/') {
    const content = path.slice(1).replace(/\/$/, '');
    if (rawKey) {
      validateStorageKey(content);
      for (const part of content.split('/')) {
        // Literal percent signs are valid key characters. Structural escapes are ambiguous.
        if (/%(?:2f|5c|00|0[ad])/i.test(part) || /^(?:\.|%2e){1,2}$/i.test(part)) reject();
      }
    } else decodedPath(content);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject();
  }
  if (url.username || url.password) reject();
  return { url, path };
}

/** Physical location only. Public URL aliases and credentials never enter this binding. */
export function storageBackendBinding(backend: StorageBackendLocation): string {
  let location: string[];
  if (backend.kind === 'local') {
    if (!isAbsolute(backend.root) || hasControl(backend.root)) reject();
    location = ['local', resolve(backend.root)];
  } else {
    const endpoint = httpLocation(backend.endpoint);
    if (!backend.bucket || /[/\\ ]/.test(backend.bucket) || hasControl(backend.bucket)) reject();
    location = ['object', endpoint.url.origin, endpoint.path.replace(/\/$/, ''), backend.bucket];
  }
  return createHash('sha256').update(JSON.stringify(location)).digest('hex');
}

/**
 * Convert an attributed reference to an exact key. This is not ownership proof.
 * Local executors must additionally prevent symlink traversal and bind the real root.
 */
export function normalizeStorageReference(
  backend: StorageBackendLocation,
  reference: string,
  options: StorageReferenceOptions = {},
): string {
  storageBackendBinding(backend);
  if (reference.startsWith('file:')) {
    if (backend.kind !== 'local' || /[?#\\]/.test(reference) || hasControl(reference)) reject();
    const match = /^file:\/\/([^/]*)(\/.*)$/.exec(reference);
    if (!match || match[1]) reject();
    decodedPath(match[2]!.slice(1));
    let file: string;
    try {
      file = fileURLToPath(reference);
    } catch {
      return reject();
    }
    const result = relative(resolve(backend.root), file);
    if (isAbsolute(result)) reject();
    return validateStorageKey(result.split(sep).join('/'));
  }
  if (reference.startsWith('/')) {
    const prefix = options.localRoutePrefix;
    if (backend.kind !== 'local' || !prefix || !prefix.startsWith('/') || prefix.endsWith('/')) reject();
    if (!reference.startsWith(`${prefix}/`) || /[?#]/.test(reference)) reject();
    return decodedPath(reference.slice(prefix.length + 1));
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(reference)) {
    if (backend.kind !== 'object' || !options.publicUrl) reject();
    const source = httpLocation(reference, options.publicUrlEncoding !== 'percent');
    const alias = httpLocation(options.publicUrl);
    const aliasPath = alias.path.replace(/\/$/, '');
    if (source.url.origin !== alias.url.origin || !source.path.startsWith(`${aliasPath}/`)) reject();
    const suffix = source.path.slice(aliasPath.length + 1);
    return options.publicUrlEncoding === 'percent' ? decodedPath(suffix) : validateStorageKey(suffix);
  }
  return validateStorageKey(reference);
}
