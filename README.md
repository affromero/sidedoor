# sidedoor

**The private side door to your self-hosted apps.** Reach a web app you run yourself from your own phone and devices — privately — and install it to the home screen. Not a tunnel. Not public by default.

If you run a self-hosted app (a homelab service, a local AI tool, a side project on a VPS), getting it onto your phone usually means becoming a part-time devops person: tunnels, certs, DNS, PWA manifests, the iOS "Add to Home Screen" dance. sidedoor packages that flow — and it leads with **private** access (your network, your tailnet), treating public exposure as the rare, explicit opt-in.

```bash
npm install sidedoor
```

## Where it fits

There are mature tools for the layers above and below this — sidedoor is the missing glue in the middle:

- **Not a tunnel.** ngrok / localtunnel / Cloudflare Tunnel / Tailscale *expose or transport* your app. sidedoor doesn't replace them — its reach guide *recommends and walks* them, private ones first.
- **Not another install-prompt lib.** `react-ios-pwa-prompt` and friends handle the `beforeinstallprompt` quirks; sidedoor keeps a thin hook and you can layer those on for fancier iOS prompts.
- **Different from Delta Chat / [webxdc](https://webxdc.org/).** webxdc ships *serverless* mini-apps over a chat — it eliminates the server. sidedoor is for when you *have* a real backend (DB, jobs, an LLM) and just need your devices to reach it privately. Same ethos, opposite mechanism.

What sidedoor uniquely gives you: **resolve the reachable URL → QR + share → a private-first, OS-aware reach guide → add-to-home-screen**, as a drop-in.

## React: a connect panel

```tsx
import 'sidedoor/styles.css';
import { ConnectPanel } from 'sidedoor/react';

export function ConnectPage() {
  // Auto-detects the current URL; embeds the reach guide when it's not https.
  return <ConnectPanel appName="My App" port="3000" />;
}
```

`<ConnectPanel>` renders the reach URL + copy, a QR (with an optional centre `logo`), share buttons (native sheet / WhatsApp / Telegram / email / copy), the add-to-home-screen steps, and — when the URL isn't https — the reach guide so you can fix that first.

### Just the reach guide

```tsx
import { ReachGuide } from 'sidedoor/react';

<ReachGuide port="3000" />          // private methods first, public ones fenced off
<ReachGuide port="3000" privateOnly /> // hide the internet-exposing options entirely
```

Private-first ordering: **same Wi-Fi** → **Tailscale** (recommended; private https from anywhere) → *then*, clearly labelled as exposure, Cloudflare / your-own-domain. Each method walks the OS-specific commands.

Other exports: `<QrCode value logo>`, `<ShareButtons url>`, and `useInstallPrompt()` (`{ canInstall, isInstalled, isIosManual, promptInstall }`).

## Server: resolve the reachable URL

Framework-agnostic — works with a web `Headers` object (Next.js), a Node `req.headers`, or a getter.

```ts
import { resolveReachUrl, isPrivateReachUrl } from 'sidedoor/server';

const url = resolveReachUrl({
  headers: await headers(),               // Next.js: from next/headers
  configuredUrl: process.env.PUBLIC_BASE_URL, // a tailnet/LAN/domain URL you saved (wins)
});
// resolveReachUrl honours x-forwarded-host / x-forwarded-proto and strips trailing slashes.
```

> From inside a container the host's LAN IP isn't knowable server-side, so for the "same Wi-Fi" case prefer the browser's address — `clientReachUrl()` from `sidedoor/react`.

## PWA

```ts
import { buildManifest, registerServiceWorker } from 'sidedoor/pwa';
```

1. Serve `buildManifest({ name: 'My App', icons: [/* 192, 512, maskable */] })` at `/manifest.webmanifest` and link it.
2. Copy `node_modules/sidedoor/src/pwa/sw.js` (exported as `sidedoor/sw.js`) to your public root so it's at `/sw.js`.
3. Call `registerServiceWorker()`.

The shipped service worker is **network-first and never caches the HTML shell**, so it's installable without the classic "stale page after redeploy" footgun.

## Installer: a shell reach menu

For a docker-compose-style installer, source the consent-first menu (default exposes nothing):

```bash
source node_modules/sidedoor/install/reach-menu.sh   # or vendor the file
sidedoor_reach_menu 3000 "My App"
# Private options first; the public one is clearly marked. Sets $SIDEDOOR_REACH_URL where determinable.
```

## Theming

Override the `--sd-*` custom properties on a wrapper (defaults are a neutral light palette):

```css
:root {
  --sd-accent: #16a34a;
  --sd-bg: #0b0b0c;
  --sd-surface: #15161a;
  --sd-border: #2a2c31;
  --sd-text: #eaeaea;
  --sd-muted: #9aa0a6;
  --sd-radius: 12px;
}
```

## Status

Early and intentionally small. React is an optional peer dependency (only `sidedoor/react` needs it); `sidedoor/server`, `sidedoor/pwa`, and the shell menu have no React requirement.

## License

MIT
