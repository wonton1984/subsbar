# zai

> Status: experimental (community/plugin-homologous B). Not enabled for
> open-source first release until a later publish-round gate. **CN region was
> not exercised this round** — do not advertise dual-region support.

| Field | Value |
| --- | --- |
| Product / plan | Z.AI / GLM Coding Plan |
| Source | `GET {origin}/api/monitor/usage/quota/limit` (pi-subs transplant) |
| Grade / admission | B / approved in the candidate tree only |
| Origins | `global` → `https://api.z.ai`；`cn` → `https://open.bigmodel.cn` |
| Verified CLI / adapter | No official CLI login. Parser transplanted from pi-subs (MIT). Official zai-coding-plugins (Apache-2.0) referenced for protocol only — no code copied |
| Last maintained | 2026-10-02 |
| Maintainer | SubsBar Node core |

## Threshold / ToS

- Global console: https://z.ai
- CN console: https://open.bigmodel.cn
- Enabling a community/plugin-homologous quota URL is the owner's choice; this project does not grant Z.AI/BigModel permission.

## Credentials

`profile.region` is **required** (`global` or `cn`). Missing region → `invalid-config` / `select-profile`. The other region's env/origin is never probed.

| Region | Env | pi reader | Origin |
| --- | --- | --- | --- |
| global | `ZAI_API_KEY` | `zai` / `zai-pi-global` | `https://api.z.ai` |
| cn | `BIGMODEL_API_KEY` | `zai-coding-cn` / `zai-pi-cn` | `https://open.bigmodel.cn` |

Then SubsBar Keychain for that profile. Explicit `sources` replace the chain.

## Quota semantics

| Upstream `type`/`unit` | Metric | Unit |
| --- | --- | --- |
| TOKENS/CREDIT_LIMIT + unit 3 | `five-hour` | percent, 5h rolling |
| TOKENS/CREDIT_LIMIT + unit 6 | `weekly` | count if currentValue/usage present, else percent |
| TIME_LIMIT | `mcp-monthly` (tool/MCP quota) | count |

`nextResetTime` accepts unix seconds or millisecond epoch. Over-limit not clamped. Plan/level strings are not copied into the report.

## 403 / errors

- 403: check key, region, and plan. Do not retry the other origin.
- 401 → `reauth-required` / `relogin-owner` (per-provider).

## Known gaps (this round, unverified)

- **CN origin not live-tested.** Dual-region is wired but not claimed supported.
- Alternate path `/api/coding/purchases/quota` (OpenUsage) **not used**; adapter follows the pi-subs path above.
- Tool-quota field names vs 5h/weekly **unverified** against a real account.
- No official CLI login (UNVERIFIED).

## Synthetic fixtures

`test/fixtures/providers/zai-synthetic-*.json`.
