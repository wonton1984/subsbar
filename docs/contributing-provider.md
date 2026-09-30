# Contributing a Provider

Thank you for extending SubsBar's coverage. This is the checklist a provider
PR must satisfy.

## 0. Eligibility

- A **real product/subscription** the data describes (API billing alone is
  not a subscription window).
- Legal, read-only access with credentials the user already owns.
- No bypassing of access controls, CAPTCHAs, or rate limits — PRs containing
  such code are rejected.

## 1. Manifest

Add `core/providers/manifests/<id>.json` conforming to
`schemas/provider-manifest-v1.schema.json`:

- `credentialReaders` with kind, configurable fields, `requires`, `purposes`,
  `owner`, `renewMode`.
- `endpoints` — HTTPS entries need a fixed `origin` (no query/userinfo) and
  `pathTemplate`; CLI entries need a `commandId`; `maxResponseBytes` bounded
  (64 KiB default, 1 MiB hard cap).
- `dataSources` with `grade`, `admission`, `coverageMetricRules` and
  `coverageMatch`.
- `metricRules` — one per emitted metric id, with `derivations` explicitly
  whitelisted and a `description` that states unit and denominator.
- `login` — the real login command (`--help`-verified) or a guide link, plus
  `launchMode` (`headless-url` / `tty` / `web-guide`) and optional
  `urlPattern` for URLs the CLI prints.

## 2. Credential readers

Implement in `core/credentials/stores.mjs` (or reuse a generic
implementation). Discover must not read secret bodies, trigger Keychain UI,
or touch the network. Resolve is the only step that reads content.

## 3. Engine

Add fetch + normalize to `core/providers/engine/` returning a SnapshotReport
via `normalizeQuota`. Hard rules:

- never clamp percent values; over-limit stays over-limit;
- missing fields stay missing (no 0-substitution);
- `resetsAt: 0` / absent reset → `resetState: "unknown"`;
- different units/pools are never summed.

## 4. Fixtures and tests

Synthetic fixtures (invent plausible values) + assertions in
`test/m2-providers.test.mjs` or a new file. Include: normal, missing-field,
over-limit, empty-response cases.

## 5. Admission

New sources start `admission: "pending"` with a `pending-verification`
diagnostic. They are merged (code ships, runtime refuses to execute) and
promoted to `approved` after a maintainer reviews the source and — when
possible — a real-account verification report.

## 6. Docs

`docs/providers/<id>.md` must state: source, credential chain, unit
semantics, known gaps, verification status.
