// Minimal usage in a React / Next.js app. Illustrative, not part of the build.
import 'thesidedoor/styles.css';
import { ConnectPanel, ReachGuide } from 'thesidedoor/react';

// A drop-in "connect a device" page. Auto-detects the current URL and embeds the
// private first reach guide when the URL is not https.
export function ConnectPage() {
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: 24 }}>
      <h1>Connect a device</h1>
      <ConnectPanel appName="My App" port="3000" />
    </main>
  );
}

// Or just the guide, private-only (no public-exposure options shown at all):
export function PrivateReachOnly() {
  return <ReachGuide port="3000" privateOnly />;
}

/*
Server side (Next.js route / server component):

  import { headers } from 'next/headers';
  import { resolveReachUrl } from 'thesidedoor/server';

  const url = resolveReachUrl({
    headers: await headers(),
    configuredUrl: process.env.PUBLIC_BASE_URL, // e.g. a tailnet URL you saved
  });

PWA:

  import { buildManifest, registerServiceWorker } from 'thesidedoor/pwa';
  // 1. serve buildManifest({ name: 'My App', icons: [...] }) at /manifest.webmanifest
  // 2. copy node_modules/thesidedoor/src/pwa/sw.js -> public/sw.js
  // 3. registerServiceWorker();   // registers /sw.js

Theme by overriding CSS variables:

  :root { --sd-accent: #16a34a; --sd-bg: #0b0b0c; --sd-text: #eaeaea; --sd-surface: #15161a; }
*/
