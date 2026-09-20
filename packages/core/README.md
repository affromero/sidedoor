# Sidedoor core

Server modules for applications that use user-configured AI providers and self-hosted infrastructure. Requires Node 22 or later. React is provided separately by `thesidedoor`.

This package is Sidedoor's shared backend. Follow the [repository verification guide](https://github.com/affromero/sidedoor#verification) to validate the current source. Public package availability depends on the latest completed release.

## AI

```ts
import { ProviderRegistry } from 'thesidedoor-core/ai';
import { apiProviders } from 'thesidedoor-core/ai/providers';

const registry = new ProviderRegistry({
  providers: apiProviders(),
  credentials: {
    async resolve(provider) {
      if (provider !== 'openai') throw new Error('Provider is not configured');
      return { apiKey: configuredKey };
    },
  },
});

for await (const event of registry.generate({
  provider: 'openai',
  model: configuredModel,
  messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  signal: requestSignal,
})) {
  if (event.type === 'text') writeText(event.text);
}
```

`configuredKey`, `configuredModel`, `prompt`, `requestSignal` and `writeText` are application inputs. Resolve credentials only after authorizing the request. Keep credentials server-side. The [runnable example](https://github.com/affromero/sidedoor/blob/main/examples/ai-text.mjs) includes the process lifecycle.

For a new provider, implement `ProviderAdapter` and register it with `ProviderRegistry`. Declare actual capabilities, implement readiness and model discovery, and emit the common generation events. Add catalog metadata when the provider needs to appear in shared credential forms. Test the transport against an HTTP or process boundary, including cancellation and errors.

## Modules

| Import                                                                  | Responsibility                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `/ai`, `/ai/providers`, `/providers/catalog`                            | Generation, adapters, capabilities and credential metadata   |
| `/access`, `/access/http`, `/access/browser`                            | Accounts, sessions, passkeys, recovery and HTTP protocol     |
| `/configuration`                                                        | Encrypted instance configuration                             |
| `/configuration/owned-credentials`, `/configuration/credential-sharing` | Revisioned owner credentials and explicit sharing            |
| `/storage`, `/storage/sql`                                              | File/SQL persistence and transaction adapters                |
| `/runtime/process`, `/runtime/cli`, `/runtime/ssh`                      | Local and remote execution                                   |
| `/runtime/outbox`, `/runtime/task-loop`                                 | Durable work reconciliation and worker loops                 |
| `/runtime/semaphore`                                                    | Redis capacity leases with exact token ownership             |
| `/observability`, `/observability/store`, `/ai/usage`                   | Explicit metric collection, persistence and token accounting |
| `/setup`, `/notifications`                                              | Setup state and notification delivery primitives             |

See the [architecture guide](https://github.com/affromero/sidedoor/blob/main/docs/architecture.md) before integrating persistence, credentials or access. The caller owns authorization and the Serializable transaction that applies related state changes. Shared persistence methods do not grant authority by themselves.

`runJobExecution()` from `/runtime/outbox` owns durable execution admission,
optional temporary workspaces, and cleanup receipts. Supply a fresh Serializable
transaction adapter, the executor instance UUID, authority validation, and an
existing trusted workspace root with its location UUID. Work starts only after
the workspace identity is recorded. Lost commit responses are reconciled against
the exact execution without replaying the work. Await all owned I/O or call
`markCleanupUnconfirmed()` when its outcome remains uncertain. Uncertainty raises
`JobExecutionCleanupError`, retains workspace evidence, and blocks settlement.
Already committed application results remain committed.

Workspace recovery requires independent proof that the exact executor and its
I/O have stopped. Read the current journal record before choosing recovery for
an unattached creation intent or removal using its recorded directory identity.
A missing directory, an expired queue lease, or a worker failure does not supply
termination proof. `openExecutionLocation(root, { create: true })` initializes a
new private location with an inode-bound marker; later calls verify that identity.
Existing roots with missing or invalid markers require operator repair. Opening
without `create` never recreates a missing location. Operator termination
verification remains an integration requirement; the filesystem helpers do not
provide it.

`copyOwnedReadableToFile()` from `/storage` copies an acquired Node stream to an
exclusive destination and waits for source and destination closure. Supply the
actual transport stream through `openSource`; late acquisitions retain cleanup
continuations after cancellation. Failed copies leave partial files in the
caller's workspace. Node stream errors can combine read and destruction failures,
so ambiguous errors raise `StorageReadCleanupError` and keep execution cleanup
unresolved. A transport with stronger release evidence can implement
`OwnedByteReader` and use `copyOwnedBytesToFile()` directly. Stream diagnostics
retain at most eight errors plus a count.

`RedisSemaphoreLease` supplies advisory capacity limits through a caller-owned Redis
`eval` connection. Commands must execute in order without replay after release.
Acquisition retries reuse the same token, and release removes only that token.
Each token belongs to one logical execution and one handle; never share it or reuse
it for later work. After connection loss, confirm the original session is drained
before issuing recovery commands on another connection.
`waitForSemaphore` owns cancellation during acquisition and waiting; unconfirmed
release raises `SemaphoreCleanupError`, which retains the parent execution guard.
Lease expiry allows advisory capacity reuse. It does not prove provider completion;
durable provider outcomes still need independent execution and settlement evidence.

`runStorageProbe()` raises `StorageProbeCleanupError` when upload or cleanup
ownership remains unresolved. The error retains the cleanup job ID and original
causes. Shared job execution recognizes it and preserves the owning workspace.
After a lost settlement response, the probe reads its exact execution receipt
before reporting uncertainty. Fully confirmed cleanup followed by revoked
authority still reports the authority failure.

Owned byte copies, Node readable copies and local reader copies return
`{ sha256, bytes }` after all bytes are written and handles are confirmed closed.
The digest covers detached source chunks. It proves copied content, not `fsync`
durability. Cancellation during closure rejects the copy instead of returning proof.

For verified migrations, supply `writeReferenceSet.verifyArtifact`. The captured
callback runs after each confirmed upload and before publication, outside database
retries. It receives the immutable operation identity, reference, target and backend
descriptor as detached values. Independently read back the destination and compare
its content evidence with the source copy. A failed verification retains the upload
as unreferenced, leaves later uploads unstarted and preserves cleanup errors.

`writeReferenceSet` owns every distinct input stream from entry and confirms their
closure concurrently before returning. A close failure after publication leaves
the committed references intact and reports cleanup uncertainty to the execution
lifecycle. Streams must emit `close` after destruction; `emitClose: false` cannot
provide that confirmation and times out conservatively.

`StorageRelocationRegistry` preserves explicit file-migration provenance without
changing sealed job results. The copy orchestrator must hash source bytes, upload
to an immutable destination, and independently read back and hash the destination.
Record matching hashes and byte counts in the same Serializable transaction as
reference replacement and application URL updates. The registry checks exact
consumer transfers, retirement evidence and preserved ownership scopes. Supplied
readback evidence is trusted application testimony; the registry does not perform
the copy itself.

`resolve()` follows only recorded relocation edges for the requested consumer.
It rejects ordinary regeneration gaps and erased scopes. Supply an explicit
`maxHops` and an optional cancellation signal; exceeding the limit rejects proof.
An unchanged asset returns `content: null`. `listForSubject()` discovers retained
receipts in pages of 100, including after tombstoning or asset metadata removal.
`eraseForSubject()` requires the exact preparing cleanup job, tombstone, generation,
epoch and snapshot retention policy. In the caller's Serializable transaction it
retains both endpoint dependencies in immutable cleanup manifests, then removes a
bounded page of receipts and their scope indexes. Missing asset attribution stays
explicitly unresolved. The cleanup resolver must handle these dependencies before
freezing discovery. An opaque allocation marker prevents erased operation reuse.
Historical aliases and source objects must remain available while jobs depend on them.

`StorageCleanupAttribution.inspectPage()` classifies persisted manifest entries
under the exact preparing job and tombstone. It validates canonical asset,
retirement and relocation attribution against the historical backend, including
after asset metadata removal. Missing attribution, unsupported raw entries and
registered consumers remain unresolved. Its proposed targets do not authorize
deletion; collector coverage, write drainage and execution ownership still apply.

`/providers/transport` supplies `createProviderTransport()` for authenticated HTTP. Capture explicit destination and method rules, then provide an `admit` callback that rechecks the request or job authority and the selected credential revision. Inject `authenticatedFetch` into the provider or SDK so each HTTP attempt passes admission, including retries and polling. Generation destinations need their own rules; a credential-validation endpoint does not authorize generation URLs. Keep unauthenticated output downloads separate. The transport rejects redirects, combines cancellation signals and bounds failed-body cleanup to one second. Admission callbacks must check their signal before committing side effects.

Use `OwnedCredentials.resolve()` for execution. An authorized settings editor can use `readForEdit(target, expectedRevision)` to repair a disabled credential. That read requires the exact displayed revision and leaves availability unchanged. Keep its values server-side and publish edits through the validated replacement flow.

`createMediaTransport()` from `/providers/transport` downloads reference audio and generated media as bounded bytes. Supply `maxBytes`, `timeoutMs`, and an `admit` callback that checks both destination policy and the original execution authority on every redirect hop. Call `downloadMedia(url, { signal })`; it sends GET requests without credentials or caller-supplied headers, preserves signed query strings, and follows at most 20 redirects. Media admission should validate saved credential metadata without recording provider usage. The downloader bounds actual streamed bytes, includes body reads in its deadline, and cancels discarded bodies. Provider credentials belong only on the separate authenticated transport.

`/configuration/credential-client` provides browser-safe edit schemas, immutable drafts and lost-response reconciliation. Prepare from the displayed owner, scope and revision. Confirming an unverified save reuses that draft. Reconciliation checks a fresh authenticated snapshot and never resubmits a mutation. A confirmed write can now be disabled, so inspect the returned key's availability. Applications supply HTTP transport and authorization.

`ProcessRunner.streamBytes()` returns owned `Uint8Array` chunks from stdout and
stderr through the same process lifecycle as text execution. Use it for decoded
audio and other binary output. `maxBufferedBytes` controls the queue high-water
mark; pipe chunks and Node stream buffers add bounded overhead. Slow consumers
pause both pipes. Set `maxOutputBytes: null` explicitly when cumulative output
must be unlimited, and consume chunks without retaining the full result. Text
execution keeps its existing buffering behavior and output limits. Cancellation terminates the process
group independently of consumer progress and reports unconfirmed cleanup.
