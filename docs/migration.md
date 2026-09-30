# Migration

## From the private pre-1.0/pi era (v0)

The pre-open-source data layer wrote a provider-keyed cache
(`subs-bar-cache.json`) into the pi agent directory and kept selection state
in `subs-bar-state.json`.

**Nothing is migrated automatically.** The v1 engine uses its own paths
(`~/.cache/subsbar/`, `~/.local/state/subsbar/`) and a config file; the pi
directory is only touched when you explicitly opt in.

### Opt-in import

```sh
node core/cli.mjs import legacy --json
```

- Source: the pi cache path (or `compatibility.pi.agentDir` /
  `compatibility.legacyCache.path` in config).
- Read-only: the source file is never modified.
- Idempotent: the source content token is remembered; re-running without
  changes is a no-op.
- Shape validation: only the strict v0 layout (`{[provider]: {report,
  fetchedAt}}`, no `schemaVersion` key) is accepted. Anything else is
  rejected, not guessed.
- Result: entries marked `dataDisposition: "legacy"`, `provenance:
  "legacy-unverified"`, freshness fixed to `expired`. They are **never**
  projected into the active card list — view them only through the explicit
  history surface.
- Unit conversions: seconds → milliseconds for resets, `usd` →
  `currency: USD`. Values are preserved verbatim (historical cents-rounding
  stays, flagged legacy-unverified).

### UserDefaults (`nativeNodePath`, `nativeSelectedProvider`)

Imported only when you explicitly choose to during first setup; providers
stay disabled either way.

## Schema evolution

- `schemaVersion: 1` is the only supported config/report version.
- Newer major versions are rejected with `schema-unsupported` — no silent
  downgrade, no file damage.
- Adding optional fields is backwards compatible; consumers ignore unknown
  optional fields but keep protocol boundaries.
