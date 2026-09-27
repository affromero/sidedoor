# Durable delegation and activity

`thesidedoor-core/runtime/delegation` records an application's narrowly scoped
permission for background work. `DelegationStore` uses one `AtomicStateBackend`
row per grant. The application supplies its transaction-bound backend and an
`authorize` callback. Sidedoor does not infer consent or current ownership.

A grant binds an instance, subject and resource generations, operation, action,
deadline, revision, and maximum number of HTTP attempts. These fields are
immutable. Changed scope requires a new grant and new consent under application
policy. `create` accepts an exact replay and rejects replacement. Replaying
creation never reactivates a revoked or completed grant.

## Application integration

Construct the store inside the application's existing serializable transaction:

```ts
const store = new DelegationStore({
  backend: sqlStateBackend(transaction, 'postgres', `app-grant:${grantId}`),
  authorize: async ({ operation, grant }) => {
    await checkCurrentApplicationAuthority(transaction, actor, operation, grant);
  },
});
```

The callback must check the authenticated actor, instance, resource ownership,
subject and resource generations, and requested action against current database
state. It receives a detached grant copy. Read and cancellation authorization may
differ from dispatch authorization. Trusted workers may need authority to record
an already admitted outcome after learner permission is revoked. That authority
must permit observation only, without authorizing another provider request.

Commit initial grant creation with the application's operation claim and durable
outbox admission. Commit each `admit` result before dispatching any external
request. A `DelegationConflictError` requires retrying the entire application
transaction, including authorization. This class never opens transactions or
retries callbacks itself. Application transaction retries must contain no
external effects.

Supply a fresh attempt UUID for every actual outbound HTTP attempt, including
SDK retries. Its fingerprint must be computed by trusted code from the complete
validated request and captured provider/model/destination policy. The store
accepts a SHA-256 digest; it does not inspect the HTTP request. Request bodies,
credentials, and provider errors must remain outside grant storage.

`admit` returns `dispatch: true` only for a newly committed reservation. Reusing
the same attempt ID and fingerprint returns `dispatch: false`, even if its
outcome is still `admitted`. Changing the fingerprint under that ID is rejected.
Do not dispatch a replay. A response lost after admission may leave an unused
reservation, or a request whose remote outcome is unknown. Budget is consumed
in either case. A fresh retry requires a fresh attempt ID and another budget
slot. These reservations bound request attempts. They cannot guarantee
exactly-once execution or enforce a monetary spending limit.

`validate` checks current authority and expiry without reserving a request. It is
useful after waits but does not authorize dispatch on its own. Revocation stops
subsequent admitted attempts. A transaction cannot retract bytes already sent
to a provider; applications should also abort active transports where possible.

## Outcomes and activity

`settle` records `succeeded`, `failed`, or `unknown`. Settlements are idempotent
for the exact attempt, fingerprint, and outcome, and never refund request
budget. Applications may record observations after grant expiry or revocation
if their authorization callback permits that action. An unknown outcome stays
unknown in this journal; reconciliation evidence belongs in the application's
operation record. `complete` requires no admitted or unknown attempts. A grant
with an unresolved outcome can be revoked to stop further work.

`activity` returns typed events with sequence numbers, timestamps, and optional
attempt UUIDs. No prompts, result text, URLs, headers, or error messages are
recorded. The latest 128 events are retained; pages contain at most 100 events.
`truncated` reports when the supplied cursor predates retained activity. A
future cursor is rejected. Activity access invokes application authorization.
The application owns translation of event types into user-facing status text.

There are at most 1,000 request reservations per grant, including completed
attempts. Do not prune attempt records within a grant or erase grant records
within the application's replay horizon. Their identities prevent replay from
receiving new dispatch permission. Retention and erasure remain application
policy, including cleanup of associated operation/outbox records. Opaque scope
identifiers must not contain learner content or secrets.
