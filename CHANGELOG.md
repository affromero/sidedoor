# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-11

Initial release. The private side door to your self hosted apps, extracted from
the connect flow in [Flight Finder](https://github.com/affromero/flight-finder).

### Added

- **`thesidedoor/react`.** `<ConnectPanel>` (the reach URL, a QR with an optional
  centre logo, a share sheet, and the add to home screen steps) and `<ReachGuide>`,
  a private first reach setup that lists same WiFi and Tailscale before fencing off
  the public options (Cloudflare, your own domain) behind a clear warning. Also
  `<QrCode>`, `<ShareButtons>`, `useInstallPrompt`, and `clientReachUrl`.
- **`thesidedoor/server`.** `resolveReachUrl`, a framework agnostic helper that
  honours `x-forwarded-*` headers, and `isPrivateReachUrl`.
- **`thesidedoor/pwa`.** `buildManifest`, `registerServiceWorker`, and a shipped
  network first service worker that never caches the HTML shell, so installing
  never serves a stale page after a redeploy.
- **`thesidedoor/install`.** A sourceable, consent first reach menu for a docker
  compose installer that exposes nothing by default.
- Themeable through `--sd-*` custom properties. React is an optional peer
  dependency, so the server, pwa, and install entry points carry no React. Built
  to ESM, CJS, and types.

[0.1.0]: https://github.com/affromero/sidedoor/releases/tag/v0.1.0
