import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
const origin = 'https://example.org';

function worker() {
  const listeners = new EventTarget();
  const cache = { put: vi.fn(), delete: vi.fn(), match: vi.fn() };
  const caches = { open: vi.fn().mockResolvedValue(cache), delete: vi.fn().mockResolvedValue(true) };
  const network = vi.fn();
  runInNewContext(source, {
    URL, fetch: network, caches,
    self: { location: { origin }, registration: { scope: origin + '/' },
      clients: { claim: vi.fn() }, addEventListener: listeners.addEventListener.bind(listeners) },
  });
  function fetchAsset(path = '/assets/app.1234abcd.js') {
    const respondWith = vi.fn();
    listeners.dispatchEvent(Object.assign(new Event('fetch'), {
      request: new Request(origin + path), respondWith,
    }));
    return respondWith.mock.calls[0]?.[0] as Promise<Response> | undefined;
  }
  return { listeners, cache, caches, network, fetchAsset };
}

it('removes only the legacy cache during activation', async () => {
  const { listeners, caches } = worker();
  const waitUntil = vi.fn();
  listeners.dispatchEvent(Object.assign(new Event('activate'), { waitUntil }));
  await waitUntil.mock.calls[0][0];
  expect(caches.delete.mock.calls).toEqual([['sidedoor-v1']]);
});

it('stores a public immutable asset and evicts it when marked private', async () => {
  const { network, cache, fetchAsset } = worker();
  network.mockResolvedValueOnce(new Response('asset', { headers: { 'cache-control': 'public, immutable' } }));
  await fetchAsset();
  expect(await cache.put.mock.calls[0][1].text()).toBe('asset');
  network.mockResolvedValueOnce(new Response('private', { headers: { 'cache-control': 'public, immutable, no-store' } }));
  expect(await (await fetchAsset())?.text()).toBe('private');
  expect(cache.delete.mock.calls[0][0].url).toBe(origin + '/assets/app.1234abcd.js');
  expect(fetchAsset('/assets/account.js')).toBeUndefined();
});
