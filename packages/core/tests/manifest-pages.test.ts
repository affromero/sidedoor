import { describe, expect, it } from 'vitest';
import { prepareStorageManifestPages, StorageManifestLimitError } from '../src/storage/cleanup-manifests';

describe('bounded cleanup manifest preparation', () => {
  it('splits by entry count with stable group-specific identities and preserves every entry', () => {
    const entries = Array.from({ length: 205 }, (_, id) => ({ id, value: `reference-${id}` }));
    const pages = [...prepareStorageManifestPages('source', entries)];
    expect(pages.map((page) => page.entries.length)).toEqual([100, 100, 5]);
    expect(pages.flatMap((page) => page.entries)).toEqual(entries);
    expect([...prepareStorageManifestPages('source', entries)]).toEqual(pages);
    const otherIds = new Set([...prepareStorageManifestPages('other', entries)].map((page) => page.id));
    expect(pages.some((page) => otherIds.has(page.id))).toBe(false);
    expect([...prepareStorageManifestPages('empty', [])]).toEqual([]);
  });
  it('counts UTF8 bytes, JSON delimiters and escaping at exact page boundaries', () => {
    const exact = 'x'.repeat(1024 * 1024 - 4);
    const pages = [...prepareStorageManifestPages('exact', [exact, 'next'])];
    expect(pages).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(pages[0]!.entries))).toBe(1024 * 1024);
    const entries = ['é'.repeat(270_000), '\\"'.repeat(140_000), '雪'.repeat(180_000)];
    const unicode = [...prepareStorageManifestPages('unicode', entries)];
    expect(unicode.length).toBeGreaterThan(1);
    expect(unicode.every((page) => Buffer.byteLength(JSON.stringify(page.entries)) <= 1024 * 1024)).toBe(
      true,
    );
    expect(unicode.flatMap((page) => page.entries)).toEqual(entries);
  });
  it('rejects a single oversized entry instead of truncating or dropping it', () => {
    expect(() => [...prepareStorageManifestPages('large', ['x'.repeat(1024 * 1024 - 3)])]).toThrow(
      StorageManifestLimitError,
    );
  });
});
