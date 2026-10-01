# grok

> Status: experimental (community C). Not enabled for open-source first
> release until a later publish-round gate. Product is **Grok Build**.
> Maintainer has **not** exercised a real Grok CLI session this round.

| Field | Value |
| --- | --- |
| Product | Grok Build |
| Primary source | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| Credentials | `GROK_HOME` file, else `~/.grok/auth.json`; optional SubsBar OAuth reference |
| Admission | `grok-proxy` **pending** |
| Last maintained | 2026-10-02 |
| Maintainer | SubsBar Node core |

## Threshold / ToS

- Product: https://x.ai
- Keys / CLI login: `grok login` (**UNVERIFIED** as a non-interactive command this round)
- Enabling the community billing proxy is the owner's choice; this project does not grant xAI permission.

## Credentials

1. `GROK_HOME` if set: a file path, or a directory containing `auth.json`.
2. Else `~/.grok/auth.json` (`access_token`).
3. Explicit SubsBar Keychain OAuth reference.

Owner CLI refreshes expired tokens (`grok login`). This adapter **does not** write `auth.json`, does not consume a refresh token, and **does not** rotate to a borrowed token on 401/403.

Management API keys (`xai-` prefix) are rejected and never sent. Browser cookies, WKE private keys, and grok.com gRPC-web are **not** implemented and are **not** promised.

## Quota semantics

| Field | Metric | Notes |
| --- | --- | --- |
| `creditUsagePercent` / credits percent | `grok-weekly` or `grok-monthly` | Period taken from `currentPeriod.start/end` (or billingPeriod bounds). ~7d → weekly; ~30d → monthly. **Monthly is not labelled weekly.** Missing weekly is omitted, not 0 |
| `onDemandCap` / `onDemandUsed` | `payg-cap` (quota) | Separate from weekly. Cap `0` → `grok-payg-disabled`, no bar. Has `quotaState` from used vs cap (`within-limit` / `at-limit` / `over-limit`; cap-only → `unknown`). `period.kind/resetState` are `unknown` unless upstream sends a PAYG cycle — weekly bounds are not copied. Missing used is not filled with 0 |

Plan / `subscription_tier_display` strings are not copied into the report. Team quota is not claimed: if the payload has no personal credits window, the report has no invented team usage.

## 401 / 403

- 401 → `reauth-required` / `relogin-owner` (run owner `grok login`). No second token is tried.
- 403 → `permission-denied`. No cookie/gRPC fallback.
- gRPC 16 / missing WKE cannot be fixed by pasting a cookie — that path is out of scope.

## Known gaps (this round, unverified)

- Real-account field names and unified-billing vs legacy monthly **unverified**.
- ACP `x.ai/billing` over `grok agent stdio` **not implemented** (community reports it missing on some CLI versions).
- Web gRPC / WKE / cookie path **not promised**.
- Team usage surface **not provided** — team accounts are not advertised as supported.
- Local `~/.grok/sessions/` spend tiles **out of scope**.

## Synthetic fixtures

`test/fixtures/providers/grok-synthetic-*.json`.
