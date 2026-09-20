import { describe, expect, it } from 'vitest';
import {
  normalizeStorageReference,
  storageBackendBinding,
  StorageReferenceError,
  type StorageBackendLocation,
} from '../src/storage/references';

const local: StorageBackendLocation = { kind: 'local', root: '/srv/media' };
const object: StorageBackendLocation = {
  kind: 'object',
  endpoint: 'https://account.storage.example',
  bucket: 'media',
};
const localOptions = { localRoutePrefix: '/api/v1/storage' };
const publicOptions = { publicUrl: 'https://cdn.example/media' };

describe('storage reference attribution', () => {
  it('preserves raw keys and decodes local routes exactly once', () => {
    expect(normalizeStorageReference(local, 'recordings/été 100%.wav')).toBe('recordings/été 100%.wav');
    expect(
      normalizeStorageReference(local, '/api/v1/storage/recordings/%C3%A9t%C3%A9%20100%25.wav', localOptions),
    ).toBe('recordings/été 100%.wav');
    expect(normalizeStorageReference(local, '/api/v1/storage/literal%2520.wav', localOptions)).toBe(
      'literal%20.wav',
    );
    expect(normalizeStorageReference(local, 'file:///srv/media/recordings/hello%20world.wav')).toBe(
      'recordings/hello world.wav',
    );
  });

  it('keeps literal public keys raw and decodes only explicitly encoded public references', () => {
    expect(normalizeStorageReference(object, 'https://cdn.example/media/100%.wav', publicOptions)).toBe(
      '100%.wav',
    );
    expect(normalizeStorageReference(object, 'https://cdn.example/media/été one.wav', publicOptions)).toBe(
      'été one.wav',
    );
    expect(normalizeStorageReference(object, 'https://cdn.example/media/literal%20.wav', publicOptions)).toBe(
      'literal%20.wav',
    );
    expect(
      normalizeStorageReference(object, 'https://cdn.example/media/hello%20world.wav', {
        ...publicOptions,
        publicUrlEncoding: 'percent',
      }),
    ).toBe('hello world.wav');
  });

  it.each([
    '',
    '../secret',
    '/srv/media-other/private',
    'a/../b',
    'a//b',
    'a\\b',
    'a\u0000b',
    'file:///srv/media-other/secret',
    'file://remote/srv/media/file',
    'file:///srv/media/../secret',
    'file:///srv/media/%2e%2e/secret',
    'file:///srv/media/a%2fb',
    '/api/v1/storage/../secret',
    '/api/v1/storage/%2e%2e/secret',
    '/api/v1/storage/a%2fb',
    '/api/v1/storage/a%5cb',
    '/api/v1/storage/bad%xx',
    '/api/v1/storage/a?key=b',
    '/api/v1/storage/a#b',
  ])('rejects unsafe local reference %j', (reference) => {
    expect(() => normalizeStorageReference(local, reference, localOptions)).toThrow(StorageReferenceError);
  });

  it.each([
    'https://cdn.example.evil/media/file',
    'https://cdn.example/media-other/file',
    'https://other.example/media/file',
    'https://cdn.example/media/../file',
    'https://cdn.example/media/%2e%2e/file',
    'https://cdn.example/media/a%2fb',
    'https://user:secret@cdn.example/media/file',
    'https://cdn.example/media/file?token=secret',
    'https://cdn.example/media/file#fragment',
    'file:///srv/media/file',
  ])('rejects public reference outside the exact alias %j', (reference) => {
    expect(() => normalizeStorageReference(object, reference, publicOptions)).toThrow(StorageReferenceError);
  });

  it('binds physical endpoints and buckets without persisting their values', () => {
    const binding = storageBackendBinding(object);
    expect(binding).toMatch(/^[a-f0-9]{64}$/);
    expect(storageBackendBinding({ ...object, endpoint: 'https://ACCOUNT.storage.example:443/' })).toBe(
      binding,
    );
    expect(storageBackendBinding({ ...object, bucket: 'other' })).not.toBe(binding);
    expect(storageBackendBinding({ ...object, endpoint: 'https://other.storage.example' })).not.toBe(binding);
    expect(storageBackendBinding({ kind: 'local', root: '/srv/media/' })).toBe(storageBackendBinding(local));
    expect(storageBackendBinding({ kind: 'local', root: '/srv/media-other' })).not.toBe(
      storageBackendBinding(local),
    );
  });

  it('never maps a trailing-slash object to its slashless neighbour', () => {
    for (const publicUrlEncoding of ['raw', 'percent'] as const) {
      expect(() =>
        normalizeStorageReference(object, 'https://cdn.example/media/item/', {
          ...publicOptions,
          publicUrlEncoding,
        }),
      ).toThrow(StorageReferenceError);
      expect(
        normalizeStorageReference(object, 'https://cdn.example/media/item', {
          publicUrl: 'https://cdn.example/media/',
          publicUrlEncoding,
        }),
      ).toBe('item');
    }
  });

  it('rejects credentials and ambiguous backend locations with sanitized errors', () => {
    for (const backend of [
      { kind: 'local', root: 'relative' },
      { ...object, endpoint: 'https://user:private-password@storage.example' },
      { ...object, endpoint: 'https://storage.example?token=private-token' },
      { ...object, bucket: 'one/two' },
    ] as StorageBackendLocation[]) {
      expect(() => storageBackendBinding(backend)).toThrow(StorageReferenceError);
      try {
        storageBackendBinding(backend);
      } catch (error) {
        expect(String(error)).not.toContain('private-');
      }
    }
  });
});
