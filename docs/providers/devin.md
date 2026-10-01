# devin

> Status: experimental (community C). Not enabled for open-source first
> release until a later publish-round gate. Maintainer has **not** exercised a
> real Devin subscription this round. **Plan-to-window mapping is unverified.**

| Field | Value |
| --- | --- |
| Product | Devin (CLI/App quota vs app.devin.ai org quota — not the same surface) |
| CLI/App source | Named TOML `~/.local/share/devin/credentials.toml` (`windsurf_api_key`) |
| Web-org source | Manual browser session + `organizationId` in SubsBar Keychain |
| Admission | Both sources **pending** |
| Last maintained | 2026-10-02 |
| Maintainer | SubsBar Node core |

## Threshold / ToS

- App: https://app.devin.ai
- Enabling a community org-quota or CLI status URL is the owner's choice; this project does not grant Cognition permission.

## Credentials — source split

The two data sources are selected independently. CLI failure **does not** fall back to another app account. Switching sources is allowed only for the same configured profile.

### `devin-cli-app`

1. File reader `devin-credentials-toml` → `windsurf_api_key`. Optional `api_server_url` is accepted only when its origin is exactly `https://server.codeium.com`; any other URL is `invalid-config` (no arbitrary hosts).
2. Devin app DB reader is registered as **not-implemented** (path/schema unverified this round).

**Blocker, not faked:** live `GetUserStatus` Connect RPC framing on `server.codeium.com` is **unverified**. The TOML reader and CLI status *normalizer* ship with synthetic fixtures; refresh still refuses pending admission, and a live CLI fetch throws `not-implemented`.

### `devin-web-org`

Requires `profile.organizationId`. Session token is a **manual Keychain import** (browser localStorage `auth1_session`, not cookies). Automatic localStorage reader is **not** on the default chain: it needs `profile.allowBrowser` **and** `privacy.allowBrowserDiscovery`, and is `not-implemented` this round.

Org ID is path-encoded as a single segment (`..` / scheme / host rejected). Request:

`GET https://app.devin.ai/api/<organizationId>/billing/quota/usage` with `x-cog-org-id`.

## Quota semantics

| Field | Metric | Notes |
| --- | --- | --- |
| `daily` | `devin-daily` | Omitted when `hide_daily_quota` is true |
| `weekly` | `devin-weekly` | Independent of daily. **Daily is never copied into weekly** |
| `extra_balance` | `extra-balance` (USD) | Optional; missing stays missing |

Plan names are not copied into the report. Remaining fractions/percents on CLI status are flipped to used only on that window.

## 403 / errors

- `No organizations found for auth1 user` → permission / org-or-session mismatch (`select-profile` / `http-403`). Not treated as a silently expired token to trigger another account.
- Other 403 → `permission-denied`. No cross-account fallback.
- 401 → `reauth-required` / `relogin-owner` (per-provider).

## Known gaps (this round, unverified)

- **Devin plan mapping** (which plan emits daily vs weekly vs extra) **unverified** — do not claim support for a named SKU.
- CLI Connect `GetUserStatus` wire format **unverified** (blocker).
- App DB path **unverified**; reader is `not-implemented`.
- Automatic Chromium localStorage import **not implemented** (manual Keychain only).
- Real-account field names **unverified**.

## Synthetic fixtures

`test/fixtures/providers/devin-synthetic-*.json`.
