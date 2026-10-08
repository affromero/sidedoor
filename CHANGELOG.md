# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-10-08

### Fixed

- Cancelling an incomplete provider response releases its reader without
  reporting the response as consumed. Pending reads cannot publish bytes or
  completion after cancellation.
  (Related to [#77](https://github.com/affromero/sidedoor/issues/77))

## [0.5.1] - 2026-10-08

### Added

- Provider account availability persists verified credit exhaustion across
  requests and restarts. Explicit checks clear it only after a validated
  operation, preserving concurrent failures. Applications keep authority over
  credentials, storage, and provider selection.
  ([#77](https://github.com/affromero/sidedoor/issues/77))

## [0.5.0] - 2026-10-01

### Added

- Applications can capture an explicit compatible endpoint, model, and optional
  key through the shared AI provider API. Saved credential bindings reject keys
  bound to another endpoint or protocol.
  ([#74](https://github.com/affromero/sidedoor/pull/74), closes [#73](https://github.com/affromero/sidedoor/issues/73))

### Changed

- Update the locked Undici version to 7.30.0.
  ([#74](https://github.com/affromero/sidedoor/pull/74))

## [0.4.1] - 2026-09-28

### Fixed

- Storage publication tolerates repeated Serializable transaction conflicts
  without repeating accepted external writes. Retry delay stays bounded,
  cancellation interrupts backoff, and final database errors remain intact.
  ([#70](https://github.com/affromero/sidedoor/pull/70), closes [#69](https://github.com/affromero/sidedoor/issues/69))

## [0.4.0] - 2026-09-27

### Added

- Applications can delegate bounded background work with durable revocation,
  request admission, replay protection, and explicit uncertain outcomes.
  ([#65](https://github.com/affromero/sidedoor/pull/65), closes [#60](https://github.com/affromero/sidedoor/issues/60))
- An optional Linux Docker runner contains executable agents and keeps provider
  credentials in a parent-owned broker. Existing local and SSH defaults remain.
  ([#65](https://github.com/affromero/sidedoor/pull/65), closes [#61](https://github.com/affromero/sidedoor/issues/61))
- Muse Spark Standard uses the existing provider configuration and compatible
  transport. Contributor training consent is never inferred.
  ([#65](https://github.com/affromero/sidedoor/pull/65), closes [#62](https://github.com/affromero/sidedoor/issues/62))

### Changed

- Remove unused exports and verify dead code and installed examples in CI.
  ([#64](https://github.com/affromero/sidedoor/pull/64))

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
[0.5.1]: https://github.com/affromero/sidedoor/releases/tag/v0.5.1
[0.5.2]: https://github.com/affromero/sidedoor/releases/tag/v0.5.2
[0.2.0]: https://github.com/affromero/sidedoor/releases/tag/v0.2.0
[0.3.0]: https://github.com/affromero/sidedoor/releases/tag/v0.3.0
[0.3.1]: https://github.com/affromero/sidedoor/releases/tag/v0.3.1
[0.3.2]: https://github.com/affromero/sidedoor/releases/tag/v0.3.2
[0.3.4]: https://github.com/affromero/sidedoor/releases/tag/v0.3.4
[0.3.3]: https://github.com/affromero/sidedoor/releases/tag/v0.3.3
