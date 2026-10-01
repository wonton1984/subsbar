# antigravity

> Status: experimental (official CLI A, local-api C). Not enabled for
> open-source first release until a later publish-round gate. Maintainer has
> **not** exercised a real Antigravity / `agy` session this round — CLI version
> and JSON shape are **unverified**.

| Field | Value |
| --- | --- |
| Product | Google Antigravity / Gemini quota pools |
| Primary source | Logged-in `agy -p /usage --output-format json` (changelog v1.1.11 non-interactive print; command A) |
| Optional | `local-api` language-server / loopback (C); Keychain OAuth only after admission |
| Admission | All sources **pending**. Refresh refuses to run them. |
| Verified CLI | **None this round.** Do not claim a specific `agy` version is supported. |
| Last maintained | 2026-10-02 |
| Maintainer | SubsBar Node core |

## Threshold / ToS

- Product: https://antigravity.google
- Changelog (non-interactive `/usage`): https://antigravity.google/docs/changelog
- Enabling a community local-api or Keychain OAuth path is the owner's choice; this project does not grant Google permission.

## Credentials

Default auto chain (once admitted) is **only** the official CLI session:

1. `agy-official-usage` — discover a fixed executable (`ANTIGRAVITY_CLI_PATH` if set and non-empty, else `/opt/homebrew/bin/agy`). Resolve returns a capability handle, not a copied token. Empty `ANTIGRAVITY_CLI_PATH` skips the CLI (does not search PATH).
2. `local-api` is **not** on the default chain. It requires `profile.allowLocalApi`. Loopback only; CSRF / same-account process checks are **unverified this round** and resolve is `not-implemented`.
3. SubsBar Keychain OAuth is a separate pending source, not in the CLI chain.

Config cannot set an arbitrary URL or shell string. CLI argv is fixed: `-p /usage --output-format json`. Timeout 15s, stdout cap 64 KiB. The runner does not send a model prompt, does not start onboarding, and does not parse TUI output.

## Quota semantics

| Pool | Metric | Notes |
| --- | --- | --- |
| Gemini (Pro/Flash shared) | `antigravity-gemini` | Percent used. Nested 5h / weekly become `antigravity-gemini` + `antigravity-gemini-weekly` when both are present |
| Non-Gemini | `antigravity-other` | Only if the payload actually includes that pool |
| Missing weekly | omitted | Old endpoints without weekly are **not** recorded as 0% |

Plan/tier strings are not copied into the report. Over-limit values are not clamped. Fractions in `0..1` are converted to percent; explicit percent fields are used as-is.

## 403 / errors

- `quotas denied` / quota-denied → `permission-denied`. **Do not** fill windows at 100% from model availability.
- Tokenless local requests on newer `agy` builds may 401 (CSRF). That is not treated as a full quota.
- HTTP 401 on an admitted remote path → `reauth-required` / `relogin-owner` (per-provider).

## Known gaps (this round, unverified)

- **CLI version lock and live `/usage` JSON shape not exercised.** Print-mode argv follows public changelog + community notes; output fields may drift.
- Local language-server port/CSRF/session binding **not implemented** (S-level evidence insufficient to ship a scanner).
- Keychain OAuth / Cloud Code remote quota **not admitted**.
- Local conversation spend / usage-trend **out of scope**.
- Real-account Gemini vs non-Gemini window names **unverified**.

## Synthetic fixtures

`test/fixtures/providers/antigravity-synthetic-*.json`.
