import { describe, expect, it } from 'vitest';
import { ObjectStorageCleanup, type ObjectCleanupPort } from '../src/storage/object-cleanup';

const location = { kind: 'object' as const, endpoint: 'https://storage.example', bucket: 'private' };

it('passes cancellation to a pending deletion and waits for the port to settle', async () => {
  const controller = new AbortController();
  const reason = new Error('Cleanup deadline');
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  let settle!: () => void;
  const settlement = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let observedAbort = false;
  const cleanup = new ObjectStorageCleanup({
    location,
    multipart,
    port: {
      kind: 'unversioned',
      listObjects: async () => ({ entries: [], isTruncated: false }),
      deleteObject: async (...args) => {
        args[1]?.addEventListener(
          'abort',
          () => {
            observedAbort = true;
          },
          { once: true },
        );
        started();
        await settlement;
      },
    },
  });
  let finished = false;
  const deletion = cleanup.delete('owned/audio', controller.signal).finally(() => {
    finished = true;
  });
  const result = expect(deletion).rejects.toBe(reason);
  await active;
  controller.abort(reason);
  await Promise.resolve();
  expect(observedAbort).toBe(true);
  expect(finished).toBe(false);
  settle();
  await result;
});
const multipart = {
  async listMultipart() {
    return { entries: [], isTruncated: false };
  },
  async abortMultipart() {
    throw new Error('No multipart upload exists in this fixture');
  },
};
function versionFixture(maxDeletePages = 100) {
  const state = {
    entries: [
      { key: 'owned/audio', versionId: 'one' },
      { key: 'owned/audio', versionId: 'two' },
      { key: 'owned/audio', versionId: 'delete-marker' },
      { key: 'owned/audio-neighbour', versionId: 'keep' },
    ],
    deny: false,
  };
  const port: ObjectCleanupPort = {
    kind: 'versioned',
    async listVersions(prefix, keyMarker, versionMarker) {
      const entries = state.entries.filter((entry) => entry.key.startsWith(prefix));
      const start = keyMarker
        ? entries.findIndex((entry) => entry.key === keyMarker && entry.versionId === versionMarker) + 1
        : 0;
      const page = entries.slice(start, start + 2);
      const last = page.at(-1);
      return {
        entries: page,
        isTruncated: start + page.length < entries.length,
        nextKey: last?.key,
        nextVersion: last?.versionId,
      };
    },
    async deleteVersion(key, versionId) {
      if (state.deny) throw new Error('Retention forbids deletion');
      state.entries = state.entries.filter((entry) => entry.key !== key || entry.versionId !== versionId);
    },
  };
  return { state, cleanup: new ObjectStorageCleanup({ location, port, multipart, maxDeletePages }) };
}

describe('shared object cleanup', () => {
  it('verifies an exact key through retained versions and ignores prefix neighbours', async () => {
    const { cleanup, state } = versionFixture();
    expect(await cleanup.has('owned/audio')).toBe(true);
    await cleanup.delete('owned/audio');
    expect(await cleanup.has('owned/audio')).toBe(false);
    expect(state.entries).toEqual([{ key: 'owned/audio-neighbour', versionId: 'keep' }]);
    state.entries.push({ key: 'avatar.png', versionId: 'historical-delete-marker' });
    expect(await cleanup.has('avatar.png')).toBe(true);
    await cleanup.delete('avatar.png');
    expect(await cleanup.has('avatar.png')).toBe(false);
  });
  it('refuses discovery while a deletion is already in flight and releases the guard afterward', async () => {
    let started!: () => void;
    let release!: () => void;
    const deleting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const allowed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanup = new ObjectStorageCleanup({
      location,
      multipart,
      port: {
        kind: 'unversioned',
        async listObjects() {
          return { entries: [], isTruncated: false };
        },
        async deleteObject() {
          started();
          await allowed;
        },
      },
    });
    const operation = cleanup.delete('owned/file');
    await deleting;
    try {
      await expect(cleanup.list('owned/').next()).rejects.toThrow('Finish deleting');
      await expect(cleanup.has('owned/file')).rejects.toThrow('Finish deleting');
    } finally {
      release();
    }
    await operation;
    expect(await cleanup.list('owned/').next()).toEqual({ done: true, value: undefined });
  });
  it('deletes an exact directory marker without targeting its slashless neighbour', async () => {
    const remaining = new Set(['owned/', 'owned', 'owned/audio']);
    const cleanup = new ObjectStorageCleanup({
      location,
      multipart,
      port: {
        kind: 'unversioned',
        async listObjects(prefix) {
          return {
            entries: [...remaining].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
            isTruncated: false,
          };
        },
        async deleteObject(key) {
          remaining.delete(key);
        },
      },
    });
    const keys: string[] = [];
    for await (const key of cleanup.list('owned/')) keys.push(key);
    expect(keys).toEqual(['owned/', 'owned/audio']);
    await cleanup.delete('owned/');
    expect([...remaining]).toEqual(['owned', 'owned/audio']);
  });
  it('discovers historical versions and removes exact keys without deleting prefix neighbours', async () => {
    const { cleanup, state } = versionFixture();
    const keys: string[] = [];
    for await (const key of cleanup.list('owned/')) keys.push(key);
    expect(keys).toEqual(['owned/audio', 'owned/audio', 'owned/audio', 'owned/audio-neighbour']);
    await cleanup.delete('owned/audio');
    await cleanup.delete('owned/audio');
    expect(state.entries).toEqual([{ key: 'owned/audio-neighbour', versionId: 'keep' }]);
  });

  it('releases discovery after iterator cancellation and preserves retention errors', async () => {
    const { cleanup, state } = versionFixture();
    const listing = cleanup.list('owned/');
    await listing.next();
    await expect(cleanup.delete('owned/audio')).rejects.toThrow('Finish collecting');
    await listing.return(undefined);
    state.deny = true;
    await expect(cleanup.delete('owned/audio')).rejects.toThrow('Retention forbids');
    expect(state.entries).toHaveLength(4);
    state.deny = false;
    await cleanup.delete('owned/audio');
    expect(state.entries).toHaveLength(1);
  });

  it('preserves progress at a bounded batch limit and completes on retry', async () => {
    const { cleanup, state } = versionFixture(1);
    await expect(cleanup.delete('owned/audio')).rejects.toThrow('batch limit');
    expect(state.entries).toHaveLength(2);
    await expect(cleanup.delete('owned/audio')).rejects.toThrow('batch limit');
    await cleanup.delete('owned/audio');
    expect(state.entries).toEqual([{ key: 'owned/audio-neighbour', versionId: 'keep' }]);
  });

  it.each(['missing', 'repeated', 'outside'] as const)('rejects %s object pagination', async (failure) => {
    const cleanup = new ObjectStorageCleanup({
      location,
      multipart,
      port: {
        kind: 'unversioned',
        async listObjects(prefix, token) {
          return {
            entries: [{ key: failure === 'outside' && token ? 'other/key' : `${prefix}key` }],
            isTruncated: true,
            nextToken: failure === 'missing' ? undefined : 'same',
          };
        },
        async deleteObject() {
          throw new Error('Discovery must not delete');
        },
      },
    });
    await expect(
      (async () => {
        for await (const key of cleanup.list('owned/')) void key;
      })(),
    ).rejects.toThrow(failure === 'outside' ? 'outside the cleanup prefix' : 'did not advance');
  });

  it('rejects an empty truncated version page instead of acknowledging erasure', async () => {
    const cleanup = new ObjectStorageCleanup({
      location,
      multipart,
      port: {
        kind: 'versioned',
        async listVersions() {
          return { entries: [], isTruncated: true, nextKey: 'owned/key' };
        },
        async deleteVersion() {
          throw new Error('No version was discovered');
        },
      },
    });
    await expect(cleanup.delete('owned/key')).rejects.toThrow('did not advance');
  });

  it('keeps captured metadata immutable and treats deletion keys as raw bytes', async () => {
    const mutableLocation = { ...location };
    const remaining = new Set(['owned/100%.wav', 'owned/literal%20.wav']);
    const cleanup = new ObjectStorageCleanup({
      location: mutableLocation,
      multipart,
      publicUrl: 'https://cdn.example/files',
      port: {
        kind: 'unversioned',
        async listObjects(prefix) {
          return {
            entries: [...remaining].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
            isTruncated: false,
          };
        },
        async deleteObject(key) {
          remaining.delete(key);
        },
      },
    });
    mutableLocation.bucket = 'other';
    expect(cleanup.location.bucket).toBe('private');
    expect(cleanup.normalize('https://cdn.example/files/owned/literal%20.wav')).toBe('owned/literal%20.wav');
    await cleanup.delete('owned/100%.wav');
    expect([...remaining]).toEqual(['owned/literal%20.wav']);
  });
});
