# openrouter

> Status: experimental (official key API A). Not enabled for open-source first
> release until a later publish-round gate. Maintainer has **not** exercised a
> real OpenRouter key this round.

| Field | Value |
| --- | --- |
| Product | OpenRouter API key quota |
| Primary source | `GET https://openrouter.ai/api/v1/key` (official, A) |
| Optional | `GET https://openrouter.ai/api/v1/credits` — **management key required** (official docs). Not wired through the refresh credential resolver this round |
| Admission | `openrouter-key` approved in the candidate tree; `openrouter-credits` **pending** |
| Verified version | Parser transplanted from pi-subs (MIT) + synthetic fixtures |
| Last maintained | 2026-10-02 |
| Maintainer | SubsBar Node core |

## Threshold / ToS

- Keys: https://openrouter.ai/keys
- Current key API: https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key
- Credits API: https://openrouter.ai/docs/api/api-reference/credits/get-credits
- Terms: https://openrouter.ai/terms

## Credentials

1. `OPENROUTER_API_KEY` (auto env name)
2. SubsBar Keychain
3. Explicit pi `openrouter`

Optional management key is a **separate purpose** (`openrouter-management`). It is not a substitute for the primary key and is not merged into the default refresh chain.

## Quota semantics

| Field | Meaning |
| --- | --- |
| `limit` / `limit_remaining` | **Key** quota window (`key-limit`, USD). Remaining is key headroom, **not** account balance |
| `usage` / `usage_daily` / weekly / monthly | Key spend counters (`kind: spend`, `scope: api-key`) |
| `limit: null` | Diagnostic `openrouter-no-limit`; no invented cap |
| `is_free_tier` | Diagnostic `openrouter-free-tier` |
| `total_credits` (credits API) | Account balance (`kind: balance`) — only if a management key actually returned the payload |

## 403 / errors

- Ordinary key 403 on `/credits`: **keep** the `/api/v1/key` snapshot; emit `openrouter-credits-unavailable`; do not copy `limit_remaining` into a balance metric.
- This round the scheduler does not pass `managementToken`, so `/credits` is not called on refresh. Adapter `mergeOpenRouterCredits` exists for tests and a future dual-lease.

## Known gaps (this round, unverified)

- **Blocker, not faked:** `/credits` needs a management key; dual-credential resolve is not in the refresh coordinator yet.
- Real-account field names unverified.
- Activity/usage-by-model APIs out of scope.

## Synthetic fixtures

`test/fixtures/providers/openrouter-synthetic-*.json`.
