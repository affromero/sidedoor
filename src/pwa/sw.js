// Serve pages from the network. Keep an offline copy only of assets that
// their publisher explicitly marks public and immutable.
const CACHE = 'sidedoor-v2:' + self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('sidedoor-v1').then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    request.mode === 'navigate' ||
    request.cache === 'no-store' ||
    request.headers.has('authorization') ||
    url.origin !== self.location.origin ||
    url.search ||
    !/^\/(?:_next\/static|assets|static)\//.test(url.pathname) ||
    !/[.-][a-f\d]{8,}\.(?:css|m?js|woff2?|png|webp|avif|svg)$/i.test(url.pathname)
  )
    return;

  event.respondWith(
    (async () => {
      let response;
      try {
        response = await fetch(request);
      } catch (error) {
        const cached = await (await caches.open(CACHE)).match(request);
        if (cached) return cached;
        throw error;
      }
      try {
        const cache = await caches.open(CACHE);
        const policy = (response.headers.get('cache-control') || '')
          .toLowerCase()
          .split(',')
          .map((directive) => directive.trim().split('=')[0]);
        if (
          response.status === 200 &&
          !response.redirected &&
          policy.includes('public') &&
          policy.includes('immutable') &&
          !policy.some((directive) =>
            ['private', 'no-store', 'no-cache', 'must-revalidate'].includes(directive),
          ) &&
          !response.headers.get('content-type')?.toLowerCase().includes('html')
        ) {
          await cache.put(request, response.clone());
        } else {
          await cache.delete(request, { ignoreVary: true });
        }
      } catch {
        // Storage may be unavailable or full. Deliver the network response.
      }
      return response;
    })(),
  );
});
