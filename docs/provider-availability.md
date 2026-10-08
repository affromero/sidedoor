# Provider account availability

`thesidedoor-core/providers/availability` remembers confirmed credit exhaustion
without changing credentials or selecting another provider. Applications remain
responsible for authentication, request admission, cancellation, and erasure.

```ts
import { ProviderAvailability } from 'thesidedoor-core/providers/availability';
import { sqlStateBackend } from 'thesidedoor-core/storage/sql';

const availability = new ProviderAvailability({
  namespace: applicationNamespace,
  instanceId: capturedInstanceId,
  backend: (id) => sqlStateBackend(authorizedDatabase, 'postgres', id),
});
const account = availability.captureAccount({
  provider: selectedProvider,
  origin: canonicalBillingOrigin,
  credential: capturedApiKey,
});

await availability.assertAvailable(account);
```

Use the existing authorized database transaction for every state read and write.
The backend must atomically compare revisions and enforce current authority,
instance ownership, cancellation, and erasure at commit. The library creates no
database connections or schema. Account handles are frozen and accepted only by
the registry that issued them. Stored identity hashes bind the exact credential,
provider, instance, namespace, and normalized billing origin. Raw credentials and
response bodies are never stored. TTS and STT using the same provider account
share this state. An endpoint on a different origin has a different account.

After the canonical transport finishes reading a failed response, pass its
bounded parsed JSON body or exact plain-text body to
`observeFailure(account, { status, body })`. It returns `true` only for these
specific signals on the provider's canonical API origin:

| Provider   | HTTP status | Response signal                                                    |
| ---------- | ----------- | ------------------------------------------------------------------ |
| OpenAI     | 429         | `error.code` is `insufficient_quota` or `credit_balance_exhausted` |
| ElevenLabs | 401         | Legacy `detail.status` is `quota_exceeded`                         |
| ElevenLabs | 402         | `detail.code` is `insufficient_credits`                            |
| Cartesia   | 402         | Plain text starts with `Model credits limit reached:`              |

The OpenAI codes appear in its [current error documentation](https://developers.openai.com/api/docs/guides/error-codes)
and [rate-limit example](https://developers.openai.com/cookbook/examples/how_to_handle_rate_limits).
ElevenLabs documents its [legacy quota status](https://elevenlabs.io/docs/help-center/technical/api-error-code-400-or-401)
and [current payment error](https://elevenlabs.io/docs/eleven-api/resources/errors).
The Cartesia prefix matches an observed credit-exhaustion response. Unrecognized
payment errors, authentication failures, rate limits, incomplete bodies, and
unsupported provider signals remain ordinary failures. They do not clear an
existing exhausted state or establish that an account is healthy.

An exhausted state has no expiry. `assertAvailable` throws
`ProviderCreditsExhaustedError` with code `PROVIDER_CREDITS_EXHAUSTED`. Its
optional `ErrorOptions` preserves the original provider error as a cause.

Only an explicitly requested check should call `recheck(account, operation,
validate, signal)`. The application uses its canonical captured provider factory
and admission path for `operation`. It must permit only that check to pass an
existing availability guard. The library calls the operation and validator once,
with no transport retry. The validator must establish an actual successful
operation, such as a successful speech response containing decodable audio.
Model listings, usage-history GETs, and an absent exhaustion marker do not prove
that credits are available.

The state clears only after successful validation and an atomic comparison with
the revision read before the check. A concurrent exhausted observation wins.
Failed, aborted, or invalid checks preserve the state. `verified_available` and
its `checkedAt` timestamp describe the last validated operation. They make no
claim about the current balance or whether a future request will succeed.
