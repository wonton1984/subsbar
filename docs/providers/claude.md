# claude

> Claude is a **required** first-release target. Offline parsing is ready.
> Live admission stays **blocked** pending applicable permission or an official
> machine protocol (2026-10-02 review: notes/claude-admission-review-2026-10-02.md).
> Do not treat 13 + blocked as a finished coverage state.

| Field | Value |
| --- | --- |
| Product | Claude Pro / Max subscription |
| Primary source | None admitted |
| Admission | `claude-cli-usage` **blocked**; `claude-oauth-usage` **blocked** |
| Verified CLI | Claude Code **2.1.285** on the maintainer Mac (2026-10-02) |
| Last maintained | 2026-10-02 |
| Maintainer | SubsBar Node core |

## Why live admission stays blocked

The 2026-10-02 admission review found a stricter terms risk than the Codex C-grade path: consumer terms limit subscription OAuth to Anthropic applications, and Claude Code rules separately restrict third-party credential intermediation. Buying a Pro/Max seat or opting in does not replace applicable permission.

Probe on Claude Code 2.1.285 (`~/.local/bin/claude`):

- There is **no** `usage` subcommand. `claude auth status --json` is machine-readable login metadata only (this machine reported `authMethod=api_key`, not a Pro/Max OAuth session).
- Official `/usage` is an **interactive TUI**. Pro/Max plan bars appear there; they are not a JSON/CLI export.
- `-p --output-format json` returns that invocation’s `total_cost_usd` / token counts. That is session cost for a print-mode prompt, **not** five-hour / seven-day / model-scoped subscription windows.

Hard lines for this project:

- Secret readers stay closed (no Keychain, `~/.claude/.credentials.json`, pi OAuth, cookie, or token paste fallback). Official docs store macOS credentials in Keychain first; the JSON file is not guaranteed after a subscription login.
- SubsBar does **not** scrape the TUI / drive a PTY.
- Borrowed `refreshToken` is discarded after shape parse: never consumed, persisted, written back, or sent through the generic refresh path.
- Refresh **refuses** every Claude source because admission is `blocked`, not `approved`.

## Offline parser (ready)

`normalizeClaudeUsage` accepts a synthetic payload only (`fetchClaudeUsage` refuses the network unless `extra.payload` is supplied):

| Field | Result |
| --- | --- |
| `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` | Percent windows. `utilization` is stored unclamped; the display layer clips the icon |
| `extra_usage` | Amount + currency/unit as a separate metric. Never mixed into subscription percent windows |
| `limits[]` | `kind=weekly_scoped` rows use `scope.model.display_name`, `percent`, `resets_at`. Generic “All models” stays on the main weekly row |
| Missing / `null` / not-started / parse failure / rate-limit cache | Independent outcomes (`window-missing`, `window-null`, `resetState=not-started`, `invalid-number`, `rate-limited-cache`) |
| `claudeAiOauth` | Offline shape only: `accessToken` / `expiresAt` / `scopes` / `subscriptionType` / `rateLimitTier`. Missing scopes ≠ proven permission. Setup-token without `user:profile` is `insufficient-scope`, not remaining 0 |

401 policy (offline): at most one reread of the same bound source after the owner updates access and identity is unchanged. Account/org + `generation` isolate late results. No `/api/oauth/profile` call is added.

## When to re-open

Re-open admission review only with applicable written permission or a supported official machine protocol, plus the checklist in the 2026-10-02 review. A machine-readable official CLI exit would also be new evidence. Until then, keep both sources `blocked`.

## 401 / 403

No live Claude usage request is issued. The offline 401 mapping is `reauth-required` after one failed same-source reread; 403 is a permission failure.

## Known gaps

- Live admission: **blocked** pending applicable permission.
- Official CLI machine-readable usage: **absent** on 2.1.285.
- Secret readers / Keychain / cookie / PTY paths: **closed**.
- Real-account Pro/Max windows: **not exercised**.

## Synthetic fixtures

`test/fixtures/providers/claude-synthetic-*.json` and `test/m2-providers.test.mjs` cover the payload shapes above. That is not an admission.
