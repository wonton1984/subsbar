# Devin

> Supported for the organization quota API (community source, grade C).
> Verified on 2026-10-27 with an authenticated CLI subscription. The separate
> CLI GetUserStatus Connect framing path remains pending and cannot refresh.

## Credentials and admission

`devin-web-org` is approved. Its default reader is `devin-credentials-toml`:
read `windsurf_api_key` from `~/.local/share/devin/credentials.toml`, written by
CLI login, and use it as Bearer on `https://app.devin.ai`. No token refresh or
credential writeback. The file reader still restricts optional `api_server_url`
to `https://server.codeium.com`; that does not change the fixed quota origin.

`devin-cli-app` remains pending: GetUserStatus Connect framing and the app DB
reader are unverified. Browser localStorage discovery is not implemented.
There is no automatic fallback to a browser account or Keychain session.
Community endpoint opt-in remains required for automatic source selection.

## Organization discovery

With a configured `profile.organizationId`, request that organization directly.
Otherwise `GET /api/organizations` with the same Bearer returns a bare array of
objects containing `org_id` and `is_primary_org`. Prefer the unique primary;
otherwise use the first item. Multiple organizations without a unique primary
produce `org-selection-ambiguous`, so the user can select an explicit ID.
An empty list or malformed ID fails. No second organization is tried after an
error and no other credential is used.

Then `GET /api/<encoded-org_id>/billing/quota/usage` with `x-cog-org-id` and the
same Bearer. Both requests have bounded time/response size and reject redirects.
Organization names, IDs and account metadata are not copied into quota reports.

## Verified flat response

| Field | Display |
| --- | --- |
| `daily_percentage` | Day quota used percent, omitted when `hide_daily_quota=true` |
| `weekly_percentage` | Independent week quota used percent |
| `daily_reset_at` / `weekly_reset_at` | ISO timestamp with timezone, converted to milliseconds |
| `overage_balance > 0` | Extra usage balance available diagnostic; currency/unit unconfirmed, no invented USD amount |
| `is_quota_plan` | Upstream plan flag; not used to manufacture missing windows |

The older nested `daily`/`weekly` response remains a fallback when corresponding
flat fields are absent. Flat null never revives stale nested values. Missing
reset remains unknown; 0 and 100 are preserved. The legacy `extra_balance` USD
metric remains separate. Daily is never relabelled as weekly. No named plan/SKU
coverage is claimed beyond the fields returned.

401 requires signing back in with the owner CLI; 403 is permission failure.
Neither causes account/organization rotation. Empty organizations is an explicit
permission failure, not a full quota.

## Evidence and limitations

Maintainer verified both organization discovery and quota HTTP 200 on 2026-10-27.
Offline fixtures are synthetic (`devin-synthetic-flat.json` and nested fixtures);
no real account IDs, credentials or quota responses are shipped. Admission of
this community source does not grant Cognition permission to other applications.

Official app: https://app.devin.ai
