# Architecture

SubsBar is a native macOS menu bar app plus an independently runnable Node
data layer, covering the AI coding subscriptions you actually pay for with
honest quota/limit/reset semantics.

> 中文说明见 [README.md](../README.md)；本文与所有 `docs/` 以英文为准。

## Components

```
┌─────────────────────────────────────────────┐
│  Native app (macos-app/)                    │
│  SubsBar (NSStatusItem + NSPopover)         │
│    ├── SubsCore: cache parsing, Node        │
│    │             discovery, refresh contract│
│    └── SubsBar: icon rendering, popover UI  │
└──────────────┬──────────────────────────────┘
               │ reads usage-v1.json (read-only)
               │ spawns: node core/cli.mjs refresh --json
┌──────────────▼──────────────────────────────┐
│  Node data layer (core/)                    │
│    ├── config/    load/validate/CAS/patch   │
│    ├── credentials/ resolver, broker,       │
│    │               readers (7 kinds)        │
│    ├── providers/ manifests ×14, registry,  │
│    │               engine (fetch/normalize) │
│    └── runtime/   locks, backoff, report,   │
│                   scheduler, projection     │
└─────────────────────────────────────────────┘
```

Dependency direction is one-way: `scripts/ → core/`. The `core/` tree never
imports from `scripts/`, and the bundled app ships `core/` + `schemas/` +
`scripts/`.

## Data layer

- **Manifest-driven**: every provider is declared in
  `core/providers/manifests/<id>.json` (grade, admission, credential chain,
  endpoints, metric rules, login flow). The registry validates and projects
  a safe view for the settings UI (`registry --json`).
- **Credential resolver**: two-phase. `discover` only checks availability
  (no secret reads, no Keychain prompts, no network). `resolve` is the only
  step that reads secret material, producing a broker reference plus identity
  scope. Explicit `sources` in config replace the entire default chain.
- **Engine**: fetch + normalize per provider. Normalization follows fixed
  semantics (see below) implemented once in `core/runtime/report.mjs`; the
  native app never re-implements them.

## Report semantics (usage-v1)

- Windows carry `used/remaining/limit/unit` with a `state` of
  `known/remaining-only/used-only/limit-only/unknown`. Only remaining →
  remaining-only (no invented denominator). Percent windows get a
  normalized 100 scale; over-limit values are preserved verbatim (only the
  icon drawing clamps).
- `0` and "unknown" are strictly different. Never derived from each other.
- Inconsistent windows (used+remaining≠limit beyond tolerance) keep raw
  values and emit an `inconsistent-values` warning; percentages use
  used/limit.
- Freshness: ≤10 min fresh, <24 h stale, ≥24 h expired, future >5 min
  invalid. Status, attempt state, freshness and data disposition are four
  orthogonal fields.
- `resetsAt` is milliseconds everywhere in v1; `0`/absent means unknown;
  crossed resets show "waiting for update" and never auto-refill.

## Refresh coordination

- The Node scheduler is the single writer of the cache. Triggers (startup /
  timer / manual / wake / cli / config-change) go through a user-level
  leader lock; a loser waits ≤2 s and returns the current snapshot with a
  `deferred` receipt.
- Per-provider tasks are isolated: one provider failing (or throwing) never
  affects the others. Commit-time checks re-validate scope and config
  generation; stale results are dropped. After a completed resample
  (`success`/`partial`/`failed`), `applyResult` stamps `profileId`/`scopeKey`
  from that attempt so a profile switch does not keep the previous
  `profileId` (usage projection would otherwise strip new windows as
  stale-foreign). Fetch failures classify `timeout`, `connect-refused`, and
  `http-5xx` separately; generic network errors are `network`, not `http-5xx`.
- Backoff milliseconds are ceiled so integer `*AtMs` gates still apply.
  `nextEligibleAtMs` is the later of cache, local backoff, and server
  `Retry-After`. `reason=manual` may skip local backoff (network-poor UX,
  2026-10-01) but must still honor server `Retry-After` and a 30 s minimum
  interval. Success clears the current error; `lastFailureAtMs` is kept.
  Cancel does not add backoff or clear `Retry-After`. Partial success
  resets the main failure counter only.
- The cache write is atomic (temp file + rename). `exit 0` is *not* success
  evidence — consumers read the structured envelope and per-provider
  attempts.

## Reading the cache (projection)

`usage --json` projects the persisted cache through the *current* config:
disabled providers are stripped to an explicit `disabled` entry, entries
from other profiles or invalidated identities become `stale-foreign` with
no values. Old scope data never reappears across account switches.

## Native app

- Reads the cache file only; refresh spawns `node core/cli.mjs refresh
  --json` (argument array, no shell), 120 s cap, SIGTERM → cancelled
  envelope within 500 ms.
- Owns Keychain writes for user-pasted API keys under the frozen naming
  convention (service `SubsBar credential <providerId>`, account
  `<providerId>:<profileId>`).
- Renders exactly what the envelope says; `test/fixtures/ipc/` golden
  vectors keep both sides numerically identical.

## Testing

- Six Node test files (offline, synthetic) — 212 assertions.
- Swift `CoreChecks` — contract suite, fails non-zero.
- Golden vectors: `test/fixtures/ipc/` are shared between both sides;
  `core/golden.mjs` produces the normalized expectations.
- Public hygiene: `scripts/check-public.mjs` (worktree + full git history)
  and `scripts/check-docs.mjs`.

### Owner credential renewal during local backoff

A locally diagnosed `credential-expired` with no HTTP status records a salted
content fingerprint of the failing file source. Factory encrypted login files,
registered JSON file readers and enabled Pi file readers support this probe.
The probe is part of refresh/resolve, never registry discovery. It performs no
Keychain lookup, login, refresh-token consumption or HTTP request. Keychain-only,
environment and unsupported stores without a reliable artifact version retain
normal backoff. Fingerprints and source bindings remain private runtime state;
paths and credential contents never enter the usage envelope.

When the same configured source changes content, its new version permits one
immediate resolve, including inside the manual minimum interval. An mtime-only
touch does not qualify. Server Retry-After always wins; HTTP 401, 403, 429 and
network failures do not qualify for this local-expiry exemption. Existing
provider-specific 401-once policies remain unchanged. Before resolving, the
leader durably reserves the version; persistence failure fails closed. Failed
or cancelled reads keep that reservation. Repeated versions cannot grant another
exemption. Each failure episode retains up to 32 consumed versions, then fails
closed to ordinary backoff; successful/partial sampling clears the episode.
Old runtime records without a fingerprint wait for the next ordinary/manual
attempt to establish a baseline; timestamps alone never grant an exemption.

The additive usage-v1 `attempt.credentialState` enum is:

- `awaiting-renewal`: local expiry, or unchanged artifact still in local backoff.
  Suggested UI text: “等待凭证续期”. Existing error/action remain authoritative.
- `renewal-retry`: a changed artifact was admitted for immediate reread. Suggested
  UI text: “凭证工件已更新，已重试”. This is an attempt annotation, **not** success;
  `attempt.state`, provider status and error still describe the actual outcome.

There is no background file watcher: the next scheduled/requested batch probes
for a change. New UI text can consume this optional field without private runtime
access; older clients safely ignore it.
