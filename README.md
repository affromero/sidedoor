<div align="center">

# sidedoor

**The private side door to your self hosted apps.**

Open an app you run yourself on your own phone, privately, and install it to the home screen.
Not a tunnel. Not public by default.

<p align="center">
  <a href="https://www.npmjs.com/package/@afromero/sidedoor"><img src="https://img.shields.io/npm/v/@afromero/sidedoor?style=flat-square&logo=npm&color=brightgreen" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@afromero/sidedoor"><img src="https://img.shields.io/npm/dm/@afromero/sidedoor?style=flat-square&color=brightgreen&label=downloads" alt="downloads"></a>
  <a href="https://github.com/affromero/sidedoor/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/affromero/sidedoor/ci.yml?branch=main&label=CI&logo=github&style=flat-square" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@afromero/sidedoor"><img src="https://img.shields.io/npm/types/@afromero/sidedoor?style=flat-square&logo=typescript" alt="types"></a>
  <a href="https://github.com/affromero/sidedoor/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square" alt="License: MIT"></a>

</div>

```bash
npm install @afromero/sidedoor
```

```tsx
import '@afromero/sidedoor/styles.css';
import { ConnectPanel } from '@afromero/sidedoor/react';

// Reach URL, QR, share sheet, and add to home screen, in one component.
<ConnectPanel appName="My App" port="3000" />
```

## Why

You self host something and it runs great on your desktop. Getting it onto your phone turns into
a chore: tunnels, certificates, DNS, a web manifest, a service worker, the iOS Add to Home Screen
steps. The easy shortcut is to put it on the public internet, which is the one thing you did not
want for a personal service.

sidedoor packages that flow and makes one deliberate choice the other tools do not: **private by
default.** Your own network and your own devices come first (LAN, Tailscale). Exposing the app to
the internet is a clearly marked opt in, never the happy path.

It ships the piece nobody packages: resolve the reachable URL, show a QR and a share sheet, walk a
private first reach setup, and install to the home screen.

## Why now

* Tailscale made a private, encrypted address you reach from anywhere, only from your own devices,
  a ten minute setup for non experts.
* PWAs grew up. A self hosted app installs to the home screen and feels native, as long as it is
  served over https, which a tailnet gives you for free with no public exposure.
* A wave of people are building local first and self hosted AI tools, all hitting the same wall:
  now get it on my phone, but keep it private.

## Use cases

* **Your local AI tool, on the couch.** You run a local LLM chat or an agent on your desktop or
  home server. sidedoor gets it onto your phone over Tailscale, installed like an app, without ever
  putting your prompts on the public internet.
* **A household app, Netflix style.** A self hosted app your family shares (chores, recipes, a
  flight tracker). Everyone opens it on their own phone from the home screen, each with their own
  private login, all pointing at one instance you run.
* **Homelab dashboards in your pocket.** Grafana, a media server, Home Assistant, a Raspberry Pi
  project. Reach them from your phone on your tailnet and pin them to the home screen, no domain
  and no public exposure.
* **Demo a side project without going public.** You are building something on a VPS or a Pi. Show
  it on your phone, or hand a QR to a friend on your WiFi, without buying a domain or opening a port.
* **You refuse to expose personal services.** You want phone access but not a public URL. sidedoor
  defaults to private and only shows the public options if you explicitly ask.
* **You ship a self hosted app and want onboarding that just works.** Drop the ConnectPanel and the
  install menu into your app so your users get onto their phones without you hand writing the QR,
  the share sheet, the PWA glue, and the Tailscale instructions.

## Where it fits

Three layers. The ones above and below are mature; the middle is empty, and that is sidedoor.

| Layer | Examples | sidedoor |
| --- | --- | --- |
| Transport | ngrok, localtunnel, Cloudflare Tunnel, Tailscale | Does not replace them. The reach guide recommends and walks them, private ones first. |
| Install prompt | react-ios-pwa-prompt, react-pwa-install | Does not reinvent. Keeps a thin hook you can layer those on top of. |
| Onboarding glue | basically nothing | This is sidedoor. |

Two contrasts worth naming:

* **Not a tunnel.** Tunnels are about public exposure (show the world). sidedoor is about private
  access (let me and my household in).
* **Not Delta Chat or webxdc.** webxdc ships serverless mini apps over a chat, so it removes the
  server. sidedoor is for when you have a real backend (a database, jobs, an LLM) and just need
  your own devices to reach it. Same self sovereign ethos, opposite mechanism.

## API

Four independent entry points. Only `@afromero/sidedoor/react` needs React.

**`/react`**

```tsx
import {
  ConnectPanel, ReachGuide, QrCode, ShareButtons, useInstallPrompt, clientReachUrl,
} from '@afromero/sidedoor/react';
```

`<ConnectPanel>` renders the reach URL, a QR (optional centre `logo`), share buttons, the install
steps, and the reach guide when the URL is not https.

`<ReachGuide port="3000" />` lists private methods first (same WiFi, then Tailscale as the
recommended way to reach it privately from anywhere), then fences off the public options
(Cloudflare, your own domain) behind a clear warning. Pass `privateOnly` to hide the public ones.
Each method walks the commands for macOS, Linux, or Windows.

**`/server`**

```ts
import { resolveReachUrl, isPrivateReachUrl } from '@afromero/sidedoor/server';

const url = resolveReachUrl({
  headers: await headers(),                   // Next.js: from next/headers
  configuredUrl: process.env.PUBLIC_BASE_URL, // a saved tailnet or LAN URL wins
});
```

Framework agnostic. Accepts a web `Headers` object, a Node `req.headers`, or a getter, honours the
`x-forwarded-*` headers, and strips trailing slashes.

**`/pwa`**

```ts
import { buildManifest, registerServiceWorker } from '@afromero/sidedoor/pwa';
```

Serve `buildManifest({ name: 'My App', icons: [...] })` at `/manifest.webmanifest`, copy
`@afromero/sidedoor/sw.js` into your public root, and call `registerServiceWorker()`. The shipped
worker is network first and never caches the HTML shell, so installing never serves a stale page
after a redeploy.

**`/install`**

```bash
source node_modules/@afromero/sidedoor/install/reach-menu.sh
sidedoor_reach_menu 3000 "My App"
```

A consent first reach menu for a docker compose installer. The default exposes nothing; private
options come first.

## Theming

Override the `--sd-*` custom properties (defaults are a neutral light palette):

```css
:root {
  --sd-accent: #16a34a;
  --sd-bg: #0b0b0c;
  --sd-surface: #15161a;
  --sd-text: #eaeaea;
  --sd-muted: #9aa0a6;
}
```

## Status

Early and intentionally small (about 20 kB packed, one runtime dependency: `qrcode`). React is an
optional peer dependency, so `/server`, `/pwa`, and the shell menu carry no React. Built to ESM,
CJS, and types with [tsup](https://tsup.egoist.dev).

## License

MIT © [Andres Romero](https://afromero.co)
