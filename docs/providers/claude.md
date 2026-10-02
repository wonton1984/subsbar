# claude

> Status: **blocked** (maturity D). Not in the v0.1 first-release set.
> First-release coverage is **13 providers + Claude blocked**.
> Re-evaluate only when the official Claude Code CLI grows a machine-readable
> usage exit. Do not treat pending as “turn it on later with the same sources.”

| Field | Value |
| --- | --- |
| Product | Claude Pro / Max subscription |
| Primary source | None admitted |
| Admission | `claude-cli-usage` **blocked**; `claude-oauth-usage` **blocked** |
| Verified CLI | Claude Code **2.1.285** on the maintainer Mac (2026-10-02) |
| Last maintained | 2026-10-02 |
| Maintainer | SubsBar Node core |

## Why blocked (2026-10-02)

Probe on Claude Code 2.1.285 (`~/.local/bin/claude`):

- There is **no** `usage` subcommand. `claude auth status --json` is machine-readable login metadata only (this machine reported `authMethod=api_key`, not a Pro/Max OAuth session).
- Official `/usage` is an **interactive TUI**. Pro/Max plan bars appear there; they are not a JSON/CLI export.
- `-p --output-format json` returns that invocation’s `total_cost_usd` / token counts. That is session cost for a print-mode prompt, **not** five-hour / seven-day / model-scoped subscription windows.
- CodexBar’s CLI path automates a PTY and scrapes the `/usage` panel. Community tools call `GET api.anthropic.com/api/oauth/usage` with a stored OAuth token or a `claude.ai` cookie.

Hard lines for this project:

- SubsBar does **not** handle Claude tokens.
- It does **not** scrape the TUI / drive a PTY.
- It does **not** read OAuth files, Keychain items, or browser cookies.

A synthetic OAuth normalizer remains in-tree for offline shape tests. Refresh **refuses** every Claude source because admission is `blocked`, not `approved`.

## When to re-open

Watch the official Claude Code CLI. Re-open admission review only if a **non-interactive, machine-readable** usage exit appears (fixed argv, bounded stdout, no token copy, no TUI). Until that evidence exists, keep both sources `blocked`.

## Public window names (not shipped)

Pro/Max publicly uses a 5-hour session window, a 7-day weekly window, plus `limits[]` model-scoped weekly rows (Fable / Sonnet and similar) and extra-usage credits. Old `seven_day_opus` alone does not cover current limits. This card does **not** claim those windows are implemented.

## 401 / 403

Not applicable while blocked. No live Claude usage request is issued.

## Known gaps

- Official CLI machine-readable usage: **absent** on 2.1.285.
- OAuth / Keychain / cookie / PTY paths: **out of scope** by policy.
- Real-account Pro/Max windows: **not exercised** and not promised.

## Synthetic fixtures

`test/m2-providers.test.mjs` still asserts the OAuth payload shape (`five_hour` / `seven_day` / `seven_day_opus`) so a future official JSON exit can reuse `normalizeClaudeUsage`. That is not an admission.
