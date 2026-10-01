# copilot

> Status: experimental (community source C). Not enabled for open-source first
> release until a later publish-round gate. Maintainer has **not** exercised a
> real Copilot subscription this round — field names may drift.

| Field | Value |
| --- | --- |
| Product / plan | GitHub Copilot (individual). Org billing is out of scope. |
| Source grade | A pending official CLI; C `GET https://api.github.com/copilot_internal/user` |
| Admission | `copilot-official-cli` **pending**; `copilot-internal` approved for the candidate tree only |
| Region | GitHub.com (no regional origin table) |
| Verified CLI / adapter | Copilot CLI `account.getQuota` **not bridged this round**. Community parser transplanted from pi-subs (MIT) + synthetic fixtures |
| Last maintained | 2026-10-02 |
| Maintainer | SubsBar Node core |

## Threshold / ToS

- GitHub Terms of Service: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- Copilot product docs: https://docs.github.com/en/copilot
- Usage/billing (official SDK, **not used this round**): https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing
- Community `copilot_internal/user` is an undocumented editor interface. Enabling it is the owner's choice; this project does not grant GitHub permission.

## Credentials and permissions

Preferred order (explicit `sources` replace the whole chain):

1. Official logged-in Copilot CLI session (`copilot-official`) — discover-only this round; resolve is `not-implemented`. Selecting this data source yields `unsupported`.
2. Community OAuth from `~/.config/github-copilot/apps.json` (`oauth_token`).
3. Named Keychain item / explicit pi `github-copilot`.

**OAuth type gate:** only GitHub App / OAuth user tokens (`gho_` / `ghu_`). Classic PAT (`ghp_`), fine-grained PAT (`github_pat_`), and App server tokens are rejected as `invalid` and are never sent to `copilot_internal`. `GH_TOKEN` is not a default Copilot credential.

## Quota semantics

| Shape | Metric | Notes |
| --- | --- | --- |
| `quota_snapshots.premium_interactions.token_based_billing=true` | `ai-credits` | New AI credits counter |
| same, `token_based_billing` false/absent | `premium-requests` | Legacy premium requests |
| `unlimited: true` | status `unlimited` | No invented numeric window |
| `limited_user_quotas.chat` + `monthly_quotas.chat` | `chat-requests` | Older editor shape |

Overage is a separate counter. Plan strings (`copilot_plan`) are not copied into the report. Over-limit values are not clamped.

## 403 / errors

- HTTP 403 on the personal endpoint → `permission-denied`. **No fallback** to org `/orgs/{org}/settings/billing/usage` or similar. Individual quota must not be labelled as organization quota.
- HTTP 401 → `reauth-required` / `relogin-owner` (per-provider; does not abort the batch).
- Non-OAuth credential → treated as 403 before any network call.

## Known gaps (this round, unverified)

- Official Copilot CLI `account.getQuota` not bridged.
- `hosts.json` / `gh` hosts.yml / default `gh:github.com` Keychain names **not verified**.
- Organization Copilot billing (admin token) **not implemented**.
- Dollar credits that exist only on the web UI **not in v0.1**.
- Real-account field names **unverified**.

## Synthetic fixtures

`test/fixtures/providers/copilot-synthetic-*.json` (fake entitlements, no live tokens).
