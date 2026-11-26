# AGENTS.md

## AI provider settings

When building or reviewing AI setup, start with the
[provider settings integration checklist](README.md#build-provider-settings).
Use the shared catalog and registry. Cover API and supported CLI transports,
model capabilities, and a server-enforced test for the exact draft before save.
Review the application's credential destination and CLI process boundary.

- Import `ProviderPicker` from `thesidedoor/react`. Supply the provider
  descriptors and model capabilities required by the feature. Keep the draft
  and test result separate from saved settings.
- Import `createProviderTestGate` from `thesidedoor-core/ai`. Resolve the
  approved destination and effective credentials on the server. Probe the
  feature with that selection, then check the receipt against the current
  selection and configuration revision inside the save transaction.
- Verify that switching the provider clears the previous model and draft
  credential. Verify that a failed test, changed selection, or rotated key
  leaves saved settings intact. Test CLI providers with the application's
  actual execution boundary and login.

## Pull request workflow

- Before opening or updating a PR, read `.github/PULL_REQUEST_TEMPLATE.md` and
  fill every applicable section, including when using the GitHub CLI or API.
  Use the specialized template when one applies.
- Every PR, including documentation and dependency updates, must link a real
  tracking issue. Search and reuse an existing issue, or open one describing
  the problem, expected behavior, and acceptance criteria before opening the PR.
- Use `Closes #123` only when the PR fully resolves the issue. Use
  `Related to #123` for partial work and list the remaining tasks.
- Keep the issue and PR consistent with the final scope and validation results.
  Follow the session's authorization rules for publishing or editing them.
  An inspection-only request does not authorize creating an issue or PR.
- Record the author's actual review-assistance preference. Do not infer consent
  to AI-assisted follow-up work or merging.
