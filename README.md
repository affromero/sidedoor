# Sidedoor

Shared infrastructure for applications whose users bring their own AI access and run their own server.

[![CI](https://img.shields.io/github/actions/workflow/status/affromero/sidedoor/ci.yml?branch=main&label=CI)](https://github.com/affromero/sidedoor/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/affromero/sidedoor/codeql.yml?branch=main&label=CodeQL)](https://github.com/affromero/sidedoor/actions/workflows/codeql.yml)
[![Secret scan](https://img.shields.io/github/actions/workflow/status/affromero/sidedoor/gitleaks.yml?branch=main&label=secret%20scan)](https://github.com/affromero/sidedoor/actions/workflows/gitleaks.yml)
[![MIT license](https://img.shields.io/github/license/affromero/sidedoor)](https://github.com/affromero/sidedoor/blob/main/LICENSE)

Sidedoor centralizes provider adapters, credential storage, password and passkey access, setup, local metrics, and background-work infrastructure. Applications supply their product behavior, database connection, and authorization policy. They consume shared changes through versioned dependencies.

The connectivity package adds reachable URLs, QR codes, sharing, and home-screen installation.

## Packages

| Package             | Purpose                                                                                    | Runtime                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `thesidedoor-core`  | AI, credentials, access, storage, setup, notifications, execution and metrics              | Node 22 or later                                                                            |
| `thesidedoor`       | React access/connectivity components, server URL helpers, PWA support and shell reach menu | React 18 or later for React components; other entry points work without React               |
| `thesidedoor-flock` | Native OS file locking used by local persistence                                           | Transitive optional dependency of core; compiler toolchain required for file-backed storage |

Install the packages your app uses. Installing `thesidedoor` does not install the server core. Import documented subpaths, such as `thesidedoor-core/ai` or `thesidedoor/react`.

## Verification

Flight Finder, Papernook, and Sotto use the shared core for provider configuration, access, storage, execution, and telemetry. The package boundary is verified through each application integration and through clean installs of the packed release archives.

CI badges above report the default branch. Candidate package tests exercise packed archives through a temporary registry, including clean installation and native locking. Public npm availability depends on the latest completed release.

## Try the current source

Use Node 22 or later and a native compiler toolchain. From this repository:

```bash
npm ci
npm run check
npm run test:package-install
```

The package verifier installs all three archives into an isolated consumer, resolves the native dependency transitively, runs a clean `npm ci`, and exercises the installed exports. It makes no AI-provider requests and needs no provider account.

For an AI request with your own account, build the source and run the [Node example](https://github.com/affromero/sidedoor/blob/main/examples/ai-text.mjs). Supply `SIDEDOOR_AI_PROVIDER`, `SIDEDOOR_AI_MODEL`, and `SIDEDOOR_AI_API_KEY` through your environment:

```bash
node examples/ai-text.mjs 'Explain why leaves change color.'
```

The example uses public package imports. It consumes the complete event stream and cancels the provider request on Ctrl+C. Model choice is explicit; Sidedoor does not substitute another provider when a request fails.

## Build on Sidedoor

| Need                                                                    | Start here                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate text, stream events, validate credentials or discover models   | [`thesidedoor-core/ai` and `/ai/providers`](https://github.com/affromero/sidedoor/blob/main/packages/core/README.md)                                                                                                                                                              |
| Add a provider or understand capability and credential definitions      | [`providers/catalog.ts`](https://github.com/affromero/sidedoor/blob/main/packages/core/src/providers/catalog.ts) and [`ProviderAdapter`](https://github.com/affromero/sidedoor/blob/main/packages/core/src/ai/index.ts)                                                           |
| Passwords, passkeys, recovery, household profiles or device access      | [`access`](https://github.com/affromero/sidedoor/tree/main/packages/core/src/access) and [`access/http`](https://github.com/affromero/sidedoor/blob/main/packages/core/src/access/http.ts)                                                                                        |
| Encrypted configuration and per-owner provider keys                     | [`configuration`](https://github.com/affromero/sidedoor/tree/main/packages/core/src/configuration)                                                                                                                                                                                |
| Local metrics and token accounting                                      | [`observability`](https://github.com/affromero/sidedoor/tree/main/packages/core/src/observability) and [`ai/usage`](https://github.com/affromero/sidedoor/blob/main/packages/core/src/ai/usage.ts)                                                                                |
| Local filesystem, R2 or S3 storage with migration and deletion journals | [Storage guide](https://github.com/affromero/sidedoor/blob/main/docs/storage.md)                                                                                                                                                                                                  |
| Setup checks, background work and notification delivery                 | [`setup`](https://github.com/affromero/sidedoor/tree/main/packages/core/src/setup), [`runtime`](https://github.com/affromero/sidedoor/tree/main/packages/core/src/runtime) and [`notifications`](https://github.com/affromero/sidedoor/tree/main/packages/core/src/notifications) |
| Phone access and home-screen installation                               | [Connectivity guide](https://github.com/affromero/sidedoor/blob/main/docs/connectivity.md)                                                                                                                                                                                        |

The [architecture guide](https://github.com/affromero/sidedoor/blob/main/docs/architecture.md) explains package boundaries, request flow, credential ownership, transaction requirements and telemetry. The [storage guide](https://github.com/affromero/sidedoor/blob/main/docs/storage.md) covers local files, R2, S3, migration and durable cleanup.

## How changes reach applications

A provider fix belongs in Sidedoor once. After verification, a release produces versioned npm archives. Each application updates its dependency and lockfile and runs its integration checks. Existing deployments retain their installed version until their operator upgrades them.

This repository is the shared source of truth. A Git submodule is useful for source development, but consumers do not need one to use the packages. App-specific prompts, model defaults, billing policy, content schemas and deployment secrets remain with the app.

## Contributing

Run `npm run check` and `npm run format:check` before submitting changes. Run `npm run test:package-install` for public API, dependency or packaging changes. Tests must exercise observable behavior, including failures and cancellation where relevant. A new catalog entry alone does not establish a working transport; add adapter and installed-consumer coverage for the capabilities it exposes.

## License

MIT. See [LICENSE](https://github.com/affromero/sidedoor/blob/main/LICENSE).
