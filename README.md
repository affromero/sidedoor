<div align="center">

# sidedoor

**The private side door to your self-hosted apps.**

Reach a web app you run yourself from your own phone and devices — privately — and install it to the home screen. Not a tunnel. Not public by default.

<p align="center">
  <a href="https://www.npmjs.com/package/@afromero/sidedoor"><img src="https://img.shields.io/npm/v/@afromero/sidedoor?style=flat-square&logo=npm&color=brightgreen" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@afromero/sidedoor"><img src="https://img.shields.io/npm/dm/@afromero/sidedoor?style=flat-square&color=brightgreen&label=downloads" alt="downloads"></a>
  <a href="https://bundlephobia.com/package/@afromero/sidedoor"><img src="https://img.shields.io/bundlephobia/minzip/@afromero/sidedoor?style=flat-square&label=react%20entry%20minzip" alt="minzipped size"></a>
  <a href="https://github.com/affromero/sidedoor/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/affromero/sidedoor/ci.yml?branch=main&label=CI&logo=github&style=flat-square" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@afromero/sidedoor"><img src="https://img.shields.io/npm/types/@afromero/sidedoor?style=flat-square&logo=typescript" alt="types"></a>
  <a href="https://github.com/affromero/sidedoor/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://github.com/affromero/sidedoor/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square" alt="PRs welcome"></a>
</p>

</div>

```bash
npm install @afromero/sidedoor
```

```tsx
import '@afromero/sidedoor/styles.css';
import { ConnectPanel } from '@afromero/sidedoor/react';

// A drop-in "connect a device" page: reach URL + QR + share + add-to-home-screen,
// and a private-first reach guide when the URL isn't yet https.
<ConnectPanel appName="My App" port="3000" />
```

## Why sidedoor?

You self-host something — a homelab service, a local AI tool, a dashboard, a side project on a small VPS. It runs great on your desktop. Then you want it **on your phone**, and you fall into a devops rabbit hole: tunnels, certificates, DNS, a web manifest, a service worker, and the iOS "Add to Home Screen" dance. The path of least resistance is to slap it on the public internet — which is exactly what you *didn't* want for a personal service.

sidedoor packages that whole flow into a drop-in, and it makes a deliberate choice the existing tools don't: **private first.** The default is your own network and your own devices (LAN, Tailscale). Exposing the app to the public internet is the rare, clearly-labelled opt-in, never the happy path.

The result is the bit nobody ships as a library: **resolve the reachable URL → QR + share → a private-first, OS-aware reach guide → add-to-home-screen.**

### Why now

Three things lined up:

- **Private mesh got trivial.** Tailscale (and WireGuard underneath it) turned "a private, encrypted address I can reach from anywhere, only from my devices" into a 10-minute, free setup for non-experts. Private-from-anywhere is finally the easy path, not the hard one.
- **PWAs grew up.** A self-hosted web app can now install to the home screen and feel native — *if* it's served over https (which a tailnet gives you for free, with no public exposure).
- **Everyone's building local-first / self-hosted AI tools.** A wave of small apps — local LLM frontends, agents, scrapers, dashboards — built by people who are great at the app and not interested in becoming network engineers, all hitting the same "now get it on my phone, but keep it private" wall.

Private mesh + PWA maturity + the self-hosted-AI wave is the moment for a private-by-default "reach your app" kit.

## How it fits (others in the space)

The problem splits into three layers. The layers above and below sidedoor are mature; the middle is empty.

| Layer | Examples | What it does | sidedoor |
| --- | --- | --- | --- |
| **Transport** | [ngrok](https://ngrok.com), [localtunnel](https://github.com/localtunnel/localtunnel), [bore](https://github.com/ekzhang/bore), [Cloudflare Tunnel](https://www.cloudflare.com/products/tunnel/), [Tailscale](https://tailscale.com) ([awesome-tunneling](https://github.com/anderspitman/awesome-tunneling)) | Expose / route your app | **Doesn't replace.** The reach guide *recommends and walks* these — private ones first. |
| **Install prompt** | [react-ios-pwa-prompt](https://www.npmjs.com/package/react-ios-pwa-prompt), [react-pwa-install](https://www.npmjs.com/package/react-pwa-install) | Handle the `beforeinstallprompt` / iOS quirks | **Doesn't reinvent.** Keeps a thin hook; layer those on for fancier iOS prompts. |
| **Onboarding glue** | *(basically nothing — `ngrokqr` and a pile of tutorials)* | "running app → on my phone", end to end | **This is sidedoor.** |

A few deliberate contrasts:

- **Not a tunnel.** Tunnels are about *public exposure* ("show the world"). sidedoor is about *private access* ("let me and my household in"). Opposite goals.
- **Different from Delta Chat / [webxdc](https://webxdc.org/).** webxdc ships *serverless* mini-apps over a chat — it eliminates the server. sidedoor is for when you *have* a real backend (a database, jobs, an LLM) and just need your own devices to reach it. Same self-sovereign ethos, opposite mechanism. *If your app can be serverless, webxdc is lovely; if it needs a backend you self-host, sidedoor gets your devices to it privately.*

## Quick start

```tsx
import '@afromero/sidedoor/styles.css';
import { ConnectPanel } from '@afromero/sidedoor/react';

export function ConnectPage() {
  // Auto-detects the current URL; embeds the reach guide when it's not https.
  return <ConnectPanel appName="My App" port="3000" />;
}
```

`<ConnectPanel>` renders the reach URL + copy, a QR (with an optional centre `logo`), share buttons (native sheet / WhatsApp / Telegram / email / copy), the add-to-home-screen steps, and — when the URL isn't https — the reach guide so you can fix that first.

## API

The package has four independent entry points. Only `@afromero/sidedoor/react` needs React.

### `@afromero/sidedoor/react`

```tsx
import { ReachGuide, ConnectPanel, QrCode, ShareButtons, useInstallPrompt, clientReachUrl } from '@afromero/sidedoor/react';

<ReachGuide port="3000" />          // private methods first, public ones fenced off
<ReachGuide port="3000" privateOnly /> // hide the internet-exposing options entirely
```

Private-first ordering: **same Wi-Fi** → **Tailscale** (recommended; private https from anywhere) → *then*, clearly labelled as exposure, Cloudflare / your-own-domain. Each method walks the OS-specific commands (macOS / Linux / Windows).

`useInstallPrompt()` returns `{ canInstall, isInstalled, isIosManual, promptInstall }`. `clientReachUrl()` returns the browser's current origin — use it for the "same Wi-Fi" case, since a containerised server can't see the host's LAN IP.

### `@afromero/sidedoor/server`

Framework-agnostic — accepts a web `Headers` object (Next.js), a Node `req.headers`, or a getter.

```ts
import { resolveReachUrl, isPrivateReachUrl } from '@afromero/sidedoor/server';

const url = resolveReachUrl({
  headers: await headers(),                   // Next.js: from next/headers
  configuredUrl: process.env.PUBLIC_BASE_URL, // a tailnet/LAN/domain URL you saved (wins)
});
```

`resolveReachUrl` honours `x-forwarded-host` / `x-forwarded-proto` and strips trailing slashes. `isPrivateReachUrl(url)` tells LAN / tailnet / loopback apart from public.

### `@afromero/sidedoor/pwa`

```ts
import { buildManifest, registerServiceWorker } from '@afromero/sidedoor/pwa';
```

1. Serve `buildManifest({ name: 'My App', icons: [/* 192, 512, maskable */] })` at `/manifest.webmanifest` and link it.
2. Copy `node_modules/@afromero/sidedoor/src/pwa/sw.js` (exported as `@afromero/sidedoor/sw.js`) to your public root so it's served at `/sw.js`.
3. Call `registerServiceWorker()`.

The shipped service worker is **network-first and never caches the HTML shell**, so it's installable without the classic "stale page after redeploy" footgun.

### `@afromero/sidedoor/install`

For a docker-compose-style installer, source the consent-first reach menu (the default exposes nothing):

```bash
source node_modules/@afromero/sidedoor/install/reach-menu.sh   # or vendor the file
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

Early and intentionally small (≈20 kB packed, zero runtime deps beyond `qrcode`). React is an optional peer dependency — `@afromero/sidedoor/server`, `/pwa`, and the shell menu have no React requirement. Built to ESM + CJS + types via [tsup](https://tsup.egoist.dev/).

Roadmap: a framework example app (Next.js), an optional Tailscale-status probe, and first-class consumption inside [Flight Finder](https://github.com/affromero/flight-finder) (its `/connect` flow is where this was extracted from).

## License

MIT © [Andres Romero](https://afromero.co)
