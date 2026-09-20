import { describe, expect, it } from 'vitest';
import { ObjectStorageCleanup } from '../../../src/storage/cleanup/backends/object-cleanup';

function fixture(maxDeletePages = 100) {
  const state = {
    uploads: [
      { key: 'owned/audio', uploadId: 'one' },
      { key: 'owned/audio', uploadId: 'two' },
      { key: 'owned/audio-extra', uploadId: 'keep' },
    ],
    objects: new Set<string>(),
    fault: '' as '' | 'denied' | 'missing' | 'repeated' | 'outside' | 'identity' | 'stuck',
    completeDuringAbort: false,
  };
  const cleanup = new ObjectStorageCleanup({
    location: { kind: 'object', endpoint: 'https://storage.example', bucket: 'private' },
    maxDeletePages,
    port: {
      kind: 'unversioned',
      async listObjects(prefix) {
        return {
          entries: [...state.objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
          isTruncated: false,
        };
      },
      async deleteObject(key) {
        state.objects.delete(key);
      },
    },
    multipart: {
      async listMultipart(prefix, keyMarker, uploadIdMarker) {
        if (state.fault === 'denied') throw new Error('Multipart listing denied');
        const entries = state.uploads.filter((entry) => entry.key.startsWith(prefix));
        const start = keyMarker
          ? entries.findIndex((entry) => entry.key === keyMarker && entry.uploadId === uploadIdMarker) + 1
          : 0;
        const page = entries.slice(start, start + 1);
        const last = page.at(-1);
        return {
          entries: page.map((entry) => ({
            key: state.fault === 'outside' ? 'other/private' : entry.key,
            uploadId: state.fault === 'identity' ? undefined : entry.uploadId,
          })),
          isTruncated: state.fault === 'repeated' || start + page.length < entries.length,
          nextKey:
            state.fault === 'missing' ? undefined : state.fault === 'repeated' ? 'owned/audio' : last?.key,
          nextUploadId: state.fault === 'repeated' ? 'one' : last?.uploadId,
        };
      },
      async abortMultipart(key, uploadId) {
        if (state.fault === 'stuck') return;
        if (state.completeDuringAbort) state.objects.add(key);
        state.uploads = state.uploads.filter((entry) => entry.key !== key || entry.uploadId !== uploadId);
      },
    },
  });
  return { state, cleanup };
}

describe('multipart erasure inventory', () => {
  it('does not abort uploads when cleanup was already cancelled', async () => {
    const { state, cleanup } = fixture();
    const original = structuredClone(state.uploads);
    const controller = new AbortController();
    const reason = new Error('Cleanup cancelled');
    controller.abort(reason);
    await expect(cleanup.delete('owned/audio', controller.signal)).rejects.toBe(reason);
    expect(state.uploads).toEqual(original);
  });
  it('finds unfinished uploads without live objects and deletes only the exact target', async () => {
    const { state, cleanup } = fixture();
    const keys = [];
    for await (const key of cleanup.list('owned/')) keys.push(key);
    expect(keys).toEqual(['owned/audio', 'owned/audio', 'owned/audio-extra']);
    expect(await cleanup.has('owned/audio')).toBe(true);
    await cleanup.delete('owned/audio');
    expect(await cleanup.has('owned/audio')).toBe(false);
    expect(state.uploads).toEqual([{ key: 'owned/audio-extra', uploadId: 'keep' }]);
  });

  it('removes an object that completed while its upload was being aborted', async () => {
    const { state, cleanup } = fixture();
    state.completeDuringAbort = true;
    await cleanup.delete('owned/audio');
    expect(await cleanup.has('owned/audio')).toBe(false);
    expect([...state.objects]).toEqual([]);
  });

  it.each(['denied', 'missing', 'repeated', 'outside', 'identity'] as const)(
    'never acknowledges incomplete %s multipart inventory',
    async (fault) => {
      const { state, cleanup } = fixture();
      state.fault = fault;
      await expect(
        (async () => {
          for await (const key of cleanup.list('owned/')) void key;
        })(),
      ).rejects.toThrow();
      await expect(cleanup.has('owned/')).rejects.toThrow();
      expect(state.uploads).toHaveLength(3);
    },
  );

  it('retains pending work when abort makes no progress', async () => {
    const { state, cleanup } = fixture();
    state.fault = 'stuck';
    await expect(cleanup.delete('owned/audio')).rejects.toThrow('did not advance');
    expect(await cleanup.has('owned/audio')).toBe(true);
  });

  it('retains batch progress and verifies completion on a retry', async () => {
    const { state, cleanup } = fixture(1);
    await expect(cleanup.delete('owned/audio')).rejects.toThrow('batch limit');
    expect(state.uploads).toEqual([{ key: 'owned/audio-extra', uploadId: 'keep' }]);
    await cleanup.delete('owned/audio');
    expect(await cleanup.has('owned/audio')).toBe(false);
  });
});
