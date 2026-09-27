# Meta Muse provider

Date: 2026-09-27

Sidedoor registers Meta's Standard text model through the existing compatible API adapter.

Select provider `meta`, model `muse-spark-1.3`, and supply the caller-selected
`apiKey` through the credential resolver. The canonical endpoint is
`https://api.meta.ai/v1`. Credential verification recognizes only the exact
authenticated `/v1/models` contract. Application authorization and credential
ownership remain the caller's responsibility.

The adapter supports text, images, JSON schemas and function tools, with the
existing streaming, cancellation, error and usage contracts. Chat Completions
does not carry reasoning between requests or supply hosted web search. Those
capabilities are not advertised. Schema rejection is surfaced from the API.

The preset includes Standard pricing of $1.25 input and $4.25 output per million
tokens and a 1,048,576-token context. `maxOutputTokens` is null because the
published request schema does not specify a numeric ceiling. Callers still set
their own request budget. `ModelPreset.maxOutputTokens` now admits null; consumers
must handle unknown ceilings. Contributor variants are excluded from presets:
they allow training on submitted data. Explicit custom model use remains the
application's responsibility.

Spark 1.3 audio understanding is currently degraded. Muse Voice Transcribe is
a separate API without word timestamps and is not registered by this integration.
Muse Glimmer can use an existing local compatible endpoint.

Sources verified on the date above:

- [Models and data tiers](https://dev.meta.ai/docs/models)
- [API protocols](https://dev.meta.ai/docs/protocols)
- [Chat request schema](https://dev.meta.ai/docs/api-reference/chat-completions/schemas)
- [Structured output limits](https://dev.meta.ai/docs/structured-output)
- [Pricing](https://dev.meta.ai/docs/pricing-rate-limits)

HTTP fixture tests verify transport contracts. They provide no evidence about
live model quality or availability. Sotto's synthetic learning evaluation can
measure explicit live selections without sending learner records.
