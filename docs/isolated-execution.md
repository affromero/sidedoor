# Optional isolated execution

`thesidedoor-core/runtime/isolated` exports `DockerIsolatedRunner`. Importing it does not require Docker. Existing process and SSH runners keep their behavior. Applications explicitly select isolation and must propagate failures.

The application supplies an immutable reviewed image, a command, finite CPU, memory, process, scratch, output and time limits, and durable identity callbacks. The runner records the container name and Docker daemon identity before creation. A lost creation acknowledgement leaves that identity unresolved. Recovery must reconcile unresolved identities against the same Docker daemon, including after the application restarts. Applications must not mark execution cleanup complete on a thrown `IsolatedCleanupError`.

The runner removes containers explicitly and checks their absence. Killing an attached Docker client does not count as cleanup. Early iterator return aborts the attached process and waits for container removal. Daemon unavailability is an uncertain cleanup outcome. The host must provide Docker's normal seccomp policy and cgroup enforcement. Do not run against an untrusted or differently configured daemon. Images must contain no credentials or sensitive files, and must be reviewed along with their entrypoint and dependencies.

Containers run as UID/GID 65532, with a read-only root filesystem, no network, no capabilities, no privilege escalation, private bounded tmpfs storage and no Docker socket. Docker daemon operators and host root remain trusted. Container isolation does not protect against kernel vulnerabilities.

## Credential broker

`thesidedoor-core/runtime/credential-broker` exports `startCredentialBroker`. Each broker owns a temporary Unix socket directory and random execution capability. Only that directory may be mounted into a runner. Real API credentials remain in the parent. The broker accepts fixed text-only Anthropic Messages or OpenAI Chat Completions requests, pins the model and token limit, rejects unknown fields and headers, disallows redirects, limits body size and concurrency, and strips provider error bodies.

Every dispatched request invokes the application's asynchronous `admit` callback. The callback must atomically reserve each attempt and revalidate revocation and credential authority. Retries are independent attempts. The callback receives a signal and must honor cancellation. Applications can provide their existing authorized fetch transport. Revocation during a stream requires aborting the broker's lifetime signal; per-request admission alone does not revoke an already dispatched stream.

Broker mounts require the application and Docker daemon to share a local Linux filesystem. macOS Docker Desktop Unix socket forwarding across its virtual machine is unsupported. Remote Docker contexts are unsupported for broker mounts. Ordinary containment tests can run against a Linux Docker Desktop engine without claiming broker interoperability.

## Claude protocol

`isolatedClaudeRelay` is a public Node bootstrap for Claude Code 2.1.283. It accepts an execution token, CLI arguments, prompt and output-token limit over stdin. It creates a loopback relay inside the network-isolated container. The relay normalizes the CLI's `/v1/messages?beta=true` request to the broker's exact endpoint and replaces all client headers. The real API key never enters the relay.

The verified request fixture uses `--bare`, empty tools, no MCP servers, disabled thinking, text input and streaming output. `--bare` explicitly excludes OAuth and keychain authentication. Subscription authentication, Codex Responses, image input, search, arbitrary tools and newer unverified CLI protocols are not supported by this adapter. The model and API endpoint are application selections. Applications must pin the CLI and image versions and must validate the full Linux broker path before enabling deployment.

## Validation

Run `SIDEDOOR_DOCKER_TEST=1 npx vitest run tests/runtime/isolated.test.ts` from `packages/core`. The opt-in suite requires its pinned Alpine and Node images to be available locally. It probes denied host paths, root writes, external networking, privilege flags, CPU throttling, process limits, memory exhaustion, scratch exhaustion, output limits and cancellation cleanup. Broker tests use real Unix HTTP sockets and mocked provider HTTP boundaries. Run `SIDEDOOR_CLAUDE_PROTOCOL=1 npx vitest run tests/runtime/claude-broker-protocol.test.ts` to check an installed Claude 2.1.283 executable against synthetic broker responses.

`tests/fixtures/isolated-claude.Dockerfile` provides a pinned agent image and a separate trusted test-supervisor target. `tests/fixtures/linux-broker-probe.mjs` exercises the real Linux child container, CLI, relay and Unix broker with synthetic provider responses. The supervisor needs Docker access; the executable-agent child receives only its broker socket directory. On Docker Desktop, run the supervisor inside Linux and use a native Docker volume for the broker directory. Mount that volume at its daemon-reported mountpoint so parent and daemon resolve the same path. This verifies Linux socket transport without relying on macOS socket forwarding.
