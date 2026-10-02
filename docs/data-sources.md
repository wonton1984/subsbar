# Data Sources

Every provider declares its sources in a manifest
(`core/providers/manifests/<id>.json`). This page explains the vocabulary;
per-provider detail lives in `docs/providers/<id>.md`.

## Source grade

| Grade | Meaning |
| --- | --- |
| A | Documented, officially supported machine interface |
| B | Visible implementation inside an official client; no stability promise |
| C | Community internal interface or local storage format |
| D | Insufficient evidence |

Grade describes evidence, not permission. A provider is only *admitted* for
execution after admission review (`admission: approved` in its data source).

## Verification status

| Status | Meaning |
| --- | --- |
| verified | Maintainer exercised the real endpoint with a real subscription (documented per milestone) |
| pending-verification | Defensive parser shipped + synthetic fixture; field names not yet confirmed against the real endpoint. **Admission stays `pending`, refresh refuses to run it.** Community contributors with a real subscription are welcome to verify (see `contributing-provider.md`). |

## Current matrix (v0.1)

| Provider | Data source | Grade | Admission | Verification |
| --- | --- | --- | --- | --- |
| codex | wham usage (community) + official CLI (pending) | C/B | approved (community) | verified |
| opencode | `opencode.ai/zen/go/v1/usage` | C | approved | verified |
| kimi | `api.kimi.com/coding/v1/usages` | C | approved | verified |
| commandcode | `api.commandcode.ai/alpha/*` | C | approved | verified |
| droid | Factory organization usage | C | approved | verified |
| cursor | IDE state.vscdb + usage-summary | C | approved | verified |
| claude | `api.anthropic.com/api/oauth/usage` | C | approved (policy admission **UNVERIFIED**) | unverified |
| copilot | `copilot_internal/user` (community; Copilot OAuth only). Official CLI pending. | C/A | approved (community) / pending (CLI) | unverified |
| zai | quota/limit, region-scoped origins (CN unverified) | B | approved | unverified |
| openrouter | `/api/v1/key` (official). `/credits` pending (management key) | A | approved (key) / pending (credits) | unverified |
| antigravity | `agy -p /usage --output-format json` (CLI version unverified). local-api pending | A/C | pending | unverified |
| devin | CLI TOML `windsurf_api_key` (Connect RPC unverified) + web org quota (manual session + orgId) | C | pending | unverified |
| grok | `cli-chat-proxy.grok.com/v1/billing?format=credits` | C | pending | unverified |
| ollama | signed `GET ollama.com/api/usage` (OpenSSH Ed25519). `OLLAMA_API_KEY` is not quota. | C | pending | unverified |

## Credential chains

Each data source lists a credential chain (see `docs/credential-security.md`).
Defaults per §2 of the contract: provider-specific env → official CLI/named
file → permitted Keychain → explicit pi compatibility. Explicit `sources` in
config replace the entire chain — nothing is silently appended.
