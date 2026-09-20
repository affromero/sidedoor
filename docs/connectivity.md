# Connectivity and installation

`thesidedoor` provides a reachable URL, QR code, share buttons and home-screen installation guidance. It works with the operator's chosen network: LAN, Tailscale, or an explicitly configured public endpoint.

```bash
npm install thesidedoor
```

## React

```tsx
import 'thesidedoor/styles.css';
import { ConnectPanel } from 'thesidedoor/react';

<ConnectPanel appName="My App" port="3000" />;
```

`ConnectPanel` renders the connection URL, QR code, share controls and installation instructions. The React entry point also exports `ReachGuide`, `QrCode`, `ShareButtons`, `useInstallPrompt` and `clientReachUrl`. React and React DOM are optional peers for the package; React components require both.

`ReachGuide` offers private access methods first. Pass `privateOnly` to hide public options. Its instructions cover macOS, Linux and Windows.

## Server URL resolution

```ts
import { resolveReachUrl } from 'thesidedoor/server';

const url = resolveReachUrl({
  headers: request.headers,
  configuredUrl: process.env.PUBLIC_BASE_URL,
});
```

The helper accepts web `Headers`, Node request headers, or a header getter. Supply a configured public-facing URL when the app operates behind a proxy. Forwarded headers must come from the app's trusted proxy configuration.

## PWA

```ts
import { buildManifest, registerServiceWorker } from 'thesidedoor/pwa';
```

Serve a manifest built with `buildManifest({ name: 'My App', icons: [...] })`, copy `thesidedoor/sw.js` into the app's public root, and call `registerServiceWorker()`. The supplied worker does not cache the HTML shell. HTTPS is required for ordinary service-worker installation outside localhost.

## Shell installer

```bash
source node_modules/thesidedoor/install/reach-menu.sh
sidedoor_reach_menu 3000 "My App"
```

The menu asks the operator to choose how the app is reached. Network setup is explicit; importing a module does not configure a tunnel or expose a server.

## Appearance

Override the CSS custom properties in the app's stylesheet:

```css
:root {
  --sd-accent: #16a34a;
  --sd-bg: #0b0b0c;
  --sd-surface: #15161a;
  --sd-text: #eaeaea;
  --sd-muted: #9aa0a6;
}
```

Authentication is a separate integration through `thesidedoor-core/access` and the access UI exports. Showing a QR code does not authorize its recipient.
