# Configuration

> 状态：v1 已实现（CAS/校验/原子写）。示例见
> [`examples/config.example.json`](../examples/config.example.json)。

## Paths

Precedence: `--config <absolute-path>` → `SUBSBAR_CONFIG` →
`${XDG_CONFIG_HOME}/subsbar/config.json` → `~/.config/subsbar/config.json`.
Only a leading `~/` is expanded; no other variable interpolation. Cache and
state live under `${XDG_CACHE_HOME:-~/.cache}/subsbar/` and
`${XDG_STATE_HOME:-~/.local/state}/subsbar/`. Config/cache/state directories
are 0700, files 0600.

## First run

There is no config file initially and nothing is auto-created. The native
settings page (or CLI) reads the canonical default via `config read` and the
first `config set` acts as the create-if-absent baseline
(`baseRevision: 0`, `contentToken: "absent"`). All providers start disabled.

## Fields

Closed object; unknown fields are rejected. Full field list and defaults:
[`schemas/config-v1.schema.json`](../schemas/config-v1.schema.json).
Highlights:

| Object | Notes |
| --- | --- |
| `runtime` | `nodePath` ("auto" or absolute), `refreshIntervalSeconds` 60..86400 (default 300), `timeoutSeconds` 1..30, `maxConcurrency` 1..6 |
| `privacy` | `allowBrowserDiscovery` (default false), `diagnostics` ("off"/"local-redacted") |
| `ui` | overview mode, menu bar mode, `selectedProvider`, provider order, up to 2 pinned metrics, per-provider card preferences |
| `providers.<id>` | `enabled`, `dataSource` (full source id or kind), `allowCommunityEndpoints`, `activeProfile`, `profiles[]` |
| `profiles[]` | `id`, `discovery` ("auto"/"only"), permission flags (`allowKeychain/allowBrowser/allowLocalApi`), explicit `sources[]`, optional `region`/`organizationId` |
| `compatibility` | `pi.enabled` (explicit opt-in), `legacyCache` import policy |

## Source specs

A source references a manifest reader: `{id, kind, reader, purpose, …}` with
kind-specific fields only (`envName` for env, `path` for file, `service`/
`account` for keychain, `executablePath` for cli, `path` for pi,
`browserProfile`+`origin` for browser). Secrets are never part of a source —
Keychain items written by the app use service
`SubsBar credential <providerId>`.

Override semantics: a non-empty `sources` array replaces the default chain
entirely; a missing candidate can advance to the next explicit source, but an
invalid one (exists but malformed, or explicitly empty env) stops the chain.
`discovery: "only"` with empty sources is a config error.

## Write path (CAS)

All writes go through `config set --stdin`:

```sh
node core/cli.mjs config read --json
# -> {schemaVersion:1, kind:"config", config, revision, contentToken}
echo '{"baseRevision":0,"contentToken":"absent","patch":{"ui":{"density":"comfortable"}}}' \
  | node core/cli.mjs config set --stdin
# -> {schemaVersion:1, kind:"config-write", revision, contentToken, invalidatedProviderIds}
```

- `patch` is a JSON Merge Patch restricted to `runtime/privacy/ui/providers/
  compatibility`; `null` deletes optional fields; `schemaVersion`/`revision`
  cannot be patched.
- Conflicts (older revision, or content token mismatch from external edits)
  return exit 2 `config-conflict`; re-read and retry — never merge locally.
- Identity-relevant changes return `invalidatedProviderIds`; the coordinator
  cancels in-flight work for those providers and old-scope cache entries stop
  being projected.

## CLI

| Command | Purpose |
| --- | --- |
| `usage --json` | read the current (projected) envelope |
| `refresh --json [--provider <id>]… [--reason <r>] [--interaction <i>]` | trigger a refresh batch |
| `config validate/read/effective --json` | validate / private read / redacted projection |
| `config set --stdin` | CAS write |
| `registry --json` | manifest + discovery metadata for settings UI |
| `import legacy --json` | explicit, idempotent v0 cache import |
| `golden` | regenerate shared golden vectors (test support) |

Exit codes: 0 success, 2 parameter/config error (`config-conflict` included),
3 refresh partial/failed/deferred/cancelled, 4 local I/O. SIGTERM cancels the
batch and yields a `cancelled` envelope within 500 ms.
