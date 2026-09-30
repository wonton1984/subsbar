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
  generation; stale results are dropped.
- Backoff: `max(effectiveInterval, min(3600, 300·2^(n-1)·(1+jitter)))`
  seconds, server `Retry-After` takes precedence, success resets the
  failure counter. The batch deadline is 120 s.
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
