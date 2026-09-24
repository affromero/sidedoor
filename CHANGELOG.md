# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] - 2026-09-24

### Fixed

- Reloading shared-password entry resumes an existing session and continues to
  the app's profile routing. ([#57](https://github.com/affromero/sidedoor/pull/57))
- Successful passkey creation or sign-in stops repeated setup offers in that
  browser. New browsers can still enroll, and removing all passkeys restores
  the offer. Cancelling a prompt or blocking browser storage preserves access.
  ([#57](https://github.com/affromero/sidedoor/pull/57), closes [#56](https://github.com/affromero/sidedoor/issues/56))

## [0.3.3] - 2026-09-24

### Fixed

- Shared-password entry displays only Password and Continue. An invisible app
  label identifies the credential to browser password managers. ([#55](https://github.com/affromero/sidedoor/pull/55))
- Native passkey prompts use the application name. ([#55](https://github.com/affromero/sidedoor/pull/55))
- App access settings group passkeys, password changes, and signed-in browsers
  with explanations and expandable controls. Manual passkey setup no longer
  requires a name. Cancelling enrollment still lets visitors choose a profile. ([#55](https://github.com/affromero/sidedoor/pull/55), closes [#54](https://github.com/affromero/sidedoor/issues/54))
- Package checks reject invalid workspace dependency resolutions. ([#55](https://github.com/affromero/sidedoor/pull/55))

### Changed

- Update the Anthropic and Google provider SDKs and the native build dependency
  while retaining Node 20 support for the React package. ([#52](https://github.com/affromero/sidedoor/pull/52))
- Update the CodeQL workflow. ([#53](https://github.com/affromero/sidedoor/pull/53))

## [0.3.2] - 2026-09-23

### Changed

- Shared access forms explain when to enter a household, claim an instance, or
  recover access.
- Household password forms identify the shared account as "Household" so
  browser password managers have a stable name to save.

## [0.3.1] - 2026-09-23

### Fixed

- Devices paired to a selected household Admin profile can receive delegated
  owner scopes. The scopes are checked again whenever a device is used and
  disappear if that profile no longer has Admin authority.

## [0.3.0] - 2026-09-22

### Added

- Household passkeys that replace the shared password on later visits and keep
  the application's profile picker and owner permissions separate.
- A skippable native passkey offer after household password entry, household
  passkey sign-in, and owner controls to list or remove household passkeys.

### Security

- Household enrollment requires a recent, single-use password-entry grant.
  Password resets and access-mode changes revoke household passkeys.

## [0.2.0] - 2026-09-20

### Added

- Shared AI provider registry and transports for OpenAI, Anthropic, Google,
  OpenAI-compatible endpoints, local processes, and remote execution.
- Passwords, WebAuthn passkeys, sessions, recovery, invitations, profiles,
  household credential sharing, and device access.
- Local filesystem, Cloudflare R2, and generic S3 storage with immutable
  references, verified migration, cleanup journals, and recovery evidence.
- Transactional outbox work, execution journals, Redis capacity leases,
  notifications, setup checks, local metrics, and token accounting.
- Clean archive installation checks for ESM, CommonJS, native file locking,
  React exports, AI streaming, credential rejection, and cancellation.

### Changed

- All packages now release in version lockstep from one verified artifact set.
- Updated supported AI and WebAuthn SDKs while retaining the Node 20 UI test
  matrix and Node 22 server runtime.
- Expanded the README with architecture diagrams, integration guides, package
  badges, application references, and release details.

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
[0.2.0]: https://github.com/affromero/sidedoor/releases/tag/v0.2.0
[0.3.0]: https://github.com/affromero/sidedoor/releases/tag/v0.3.0
[0.3.1]: https://github.com/affromero/sidedoor/releases/tag/v0.3.1
[0.3.2]: https://github.com/affromero/sidedoor/releases/tag/v0.3.2
[0.3.4]: https://github.com/affromero/sidedoor/releases/tag/v0.3.4
[0.3.3]: https://github.com/affromero/sidedoor/releases/tag/v0.3.3
