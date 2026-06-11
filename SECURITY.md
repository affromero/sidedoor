# Security Policy

## Supported versions

thesidedoor is pre 1.0. Security fixes land on the latest published version on
npm. Please upgrade to the newest release before reporting.

## Reporting a vulnerability

Please report security issues privately, not in a public issue.

- Preferred: open a private report through GitHub, on the repository's
  **Security** tab, under **Report a vulnerability** (GitHub Security Advisories).
- Or email **me@afromero.co** with a description and, if possible, a minimal
  reproduction.

You can expect an acknowledgement within a few days. Once the issue is
confirmed and a fix is available, the advisory is published and the reporter
credited, unless anonymity is requested.

## Scope

This package resolves a reachable URL, renders connection UI, and ships a
service worker and a sourceable shell menu. It exposes nothing to the network by
itself and is private by default. Reports that are most useful concern, for
example, a reach URL resolving to an unintended host, the service worker caching
something it should not, or the shell menu exposing the app without consent.
