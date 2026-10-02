# ollama

> Status: experimental (community C). Product is **Ollama Cloud**.
> Not enabled for open-source first release until a later publish-round gate.
> Maintainer has **not** exercised a real signed `/api/usage` against a live
> account this round — field names and new vs legacy billing are **unverified**.

| Field | Value |
| --- | --- |
| Product | Ollama Cloud (Pro / Max / Team / Free) |
| Primary source | Signed `GET https://ollama.com/api/usage?ts=<unix>` |
| Credentials | `~/.ollama/id_ed25519` (request-signer). `ollama signin` binds that key. |
| Admission | `ollama-signed` **pending**. Refresh refuses to run it. |
| Verified CLI | Ollama **0.32.9** present on the maintainer Mac; daemon was **not** running; no live Cloud call. |
| Last maintained | 2026-10-02 |
| Maintainer | SubsBar Node core |

## Threshold / ToS

- Product: https://ollama.com
- Pricing (public, 2026-08+ monthly credits): https://ollama.com/pricing
- Sign-in: `ollama signin` (needs a running local daemon; prints nothing useful when the daemon is down)
- Enabling this community usage endpoint is the owner's choice; this project does not grant Ollama permission.

## Credentials

Default auto chain (once admitted) is **only** the local signing key:

1. `ollama-signing-key` — `~/.ollama/id_ed25519` (or an explicit file path). Discover checks existence only. Resolve reads the OpenSSH PEM into the in-process broker. The private key is **not** placed in config, logs, URLs, or the `Authorization` header.
2. Each request signs the allowlisted challenge `GET,/api/usage?ts=<unix>` (optional documented sibling `POST,/api/me?ts=<unix>` is **not** called this round). Header is `<ssh-ed25519-blob-b64>:<ed25519-sig-b64>` — the same scheme the official Go client uses.
3. `node:crypto` / OpenSSL 3 cannot decode OpenSSH Ed25519 directly. Unencrypted keys are parsed in-process and imported as JWK. Passphrase-encrypted keys are rejected (`file-malformed`).
4. **`OLLAMA_API_KEY` is not a quota credential.** A bearer-looking token is rejected with 403 and never sent to `/api/usage`.
5. A key file can exist before `ollama signin`. Local files do **not** prove a Cloud session. 401 from the signed usage call means the key is not linked; the user runs owner `ollama signin`. This round did **not** hit ollama.com with the maintainer key.

Browser cookies / settings HTML scrape (CodexBar monthly path) are **not** implemented and are **not** promised.

## Quota semantics

Public billing is dual-form. This adapter shows **whatever windows the JSON actually contains**. It does not guess a reset clock.

| Public form | Metric | Notes |
| --- | --- | --- |
| New Pro/Max/Team monthly credits (2026-08+) | `ollama-monthly` | Dollar used+limit → currency window. Percent `utilization` stays percent. Calendar period; `resetState` unknown unless the payload has a reset timestamp |
| Legacy session (5h) | `ollama-session` | Rolling; duration 5h is the named window, not a guessed reset |
| Legacy weekly (7d) | `ollama-weekly` | Rolling; same reset rule |
| `limits[]` | mapped by name | `usage` in `0..1` becomes percent. Unknown names are omitted, not zeroed |

Missing session or weekly on a new-plan payload is omitted, not written as 0%. Over-limit values are not clamped. Plan / tier strings are not copied into the report.

## 401 / 403

- 401 → signing key is not bound to an ollama.com account (`reauth-required` / owner `ollama signin`).
- 403 on an API key or unreadable/encrypted key → `permission-denied`. No cookie fallback.
- Local daemon down does not by itself mean Cloud is unsigned; it only blocks the owner CLI `signin` helper.

## Known gaps (this round, unverified)

- Live `/api/usage` JSON shape **unverified**. OpenUsage documents session/weekly fractions; CodexBar documents new monthly dollars on the settings HTML. Both shapes are parsed defensively.
- `POST /api/me` plan badge **not called**.
- Encrypted OpenSSH keys **unsupported**.
- Web session / cookie monthly scrape **out of scope**.
- Maintainer daemon was off; Cloud sign-in state was **not** observed.

## Synthetic fixtures

`test/fixtures/providers/ollama-synthetic-*.json`.
