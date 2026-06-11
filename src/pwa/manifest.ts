export interface ManifestIcon {
  src: string;
  sizes: string;
  type?: string;
  purpose?: string;
}

export interface BuildManifestOptions {
  name: string;
  shortName?: string;
  description?: string;
  startUrl?: string;
  display?: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser';
  themeColor?: string;
  backgroundColor?: string;
  icons?: ManifestIcon[];
}

/**
 * Build a web app manifest object. Serve it at e.g. /manifest.webmanifest and
 * link it from <head>. Include at least a 192px and a 512px icon, and a maskable
 * one, for a clean Android home-screen install.
 */
export function buildManifest(opts: BuildManifestOptions): Record<string, unknown> {
  return {
    name: opts.name,
    short_name: opts.shortName ?? opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    start_url: opts.startUrl ?? '/',
    display: opts.display ?? 'standalone',
    theme_color: opts.themeColor ?? '#0b0b0c',
    background_color: opts.backgroundColor ?? '#0b0b0c',
    icons: opts.icons ?? [],
  };
}

/**
 * Register the sidedoor service worker. Copy `node_modules/sidedoor/src/pwa/sw.js`
 * (exported as `sidedoor/sw.js`) into your public root so it is served at `/sw.js`.
 */
export function registerServiceWorker(path = '/sw.js'): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(path).catch(() => {});
  });
}
