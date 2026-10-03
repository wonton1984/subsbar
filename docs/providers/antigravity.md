# antigravity

> Status: **supported** for the official CLI usage path. Verified 2026-10-03
> against `agy` **1.2.16** (`agy -p /usage --output-format json`).
> `local-api` stays pending / not-implemented.

| Field | Value |
| --- | --- |
| Product | Google Antigravity / Gemini quota pools |
| Primary source | Logged-in `agy -p /usage --output-format json` (official print-mode; grade A) |
| Optional | `local-api` language-server / loopback (C); Keychain OAuth only after admission |
| Admission | `antigravity-cli` **approved** (2026-10-03). `antigravity-local-api` **pending**. |
| Verified CLI | `agy` **1.2.16** on the maintainer Mac (`~/.local/bin/agy`) |
| Last maintained | 2026-10-03 |
| Maintainer | SubsBar Node core |

## Threshold / ToS

- Product: https://antigravity.google
- Changelog (non-interactive `/usage`): https://antigravity.google/docs/changelog
- Enabling a community local-api or Keychain OAuth path is the owner's choice; this project does not grant Google permission.

## Credentials

Default auto chain is **only** the official CLI session:

1. `agy-official-usage` — discover a fixed executable (`ANTIGRAVITY_CLI_PATH` if set and non-empty, else `/opt/homebrew/bin/agy`). Resolve returns a capability handle, not a copied token. Empty `ANTIGRAVITY_CLI_PATH` skips the CLI (does not search PATH). This machine’s verified binary is `~/.local/bin/agy` (set `ANTIGRAVITY_CLI_PATH` if not using Homebrew).
2. `local-api` is **not** on the default chain. It requires `profile.allowLocalApi`. Loopback only; CSRF / same-account process checks are **unverified** and resolve is `not-implemented`.
3. SubsBar Keychain OAuth is a separate pending source, not in the CLI chain.

Config cannot set an arbitrary URL or shell string. CLI argv is fixed: `-p /usage --output-format json`. Timeout 15s, stdout cap 64 KiB. The runner does not send a model prompt, does not start onboarding, and does not parse TUI output.

## Quota semantics (verified 2026-10-03)

Official 1.2.16 JSON is a print envelope. Subscription windows live in
`command.data.groups[].buckets[]`, not in the human TSV `response` string and
not in the envelope `usage` token counts (those are this invocation only).

| Pool | Metric | Notes |
| --- | --- | --- |
| Gemini Models (Flash / Pro shared) | `antigravity-gemini` / `antigravity-gemini-weekly` | `window=5h` is primary; `window=weekly` is the week row |
| Claude and GPT models (Opus / Sonnet / GPT-OSS) | `antigravity-other` / `antigravity-other-weekly` | Same 5h / weekly split |
| `remaining_fraction` | used percent | Field is **remaining** in `0..1`. Stored used = `(1 - remaining_fraction) * 100`. Not clamped |
| `reset_time` | UTC ISO | `period.resetState=known` |
| credits / balance | absent | This payload has no currency or credit balance |

Plan/tier and group description strings are not copied into the report. Missing weekly is omitted, not recorded as 0%. The older `quota.gemini.percentage` shape is still accepted as a defensive fallback.

## 403 / errors

- `quotas denied` / quota-denied → `permission-denied`. **Do not** fill windows at 100% from model availability.
- Tokenless local requests on newer `agy` builds may 401 (CSRF). That is not treated as a full quota.
- HTTP 401 on an admitted remote path → `reauth-required` / `relogin-owner` (per-provider).

## Known gaps

- Local language-server port/CSRF/session binding **not implemented**.
- Keychain OAuth / Cloud Code remote quota **not admitted**.
- Local conversation spend / usage-trend **out of scope**.
- No independent plan-tier field was present on the verified account.

## Synthetic fixtures

`test/fixtures/providers/antigravity-synthetic-*.json` (including `antigravity-synthetic-cli-groups.json` for the official 1.2.16 envelope). Real-account JSON stays local.
