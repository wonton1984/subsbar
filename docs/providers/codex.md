# codex

> 状态：已实现（来源成熟度 C）。wham usage 社区接口；准入未变。

| Field | Value |
| --- | --- |
| Product | OpenAI Codex subscription |
| Primary source | Codex CLI `~/.codex/auth.json`（`codex-auth-file`）→ `GET https://chatgpt.com/backend-api/wham/usage` |
| Optional | pi `openai-codex`（陈旧、无人刷新；本机应以 file 源为准）；official CLI usage pending |
| Admission | `codex-wham` **approved**（同源同端点）。`codex-official-cli` **pending** |
| Last maintained | 2026-10-07 |
| Maintainer | SubsBar Node core |

## 凭证

默认链优先读 Codex CLI 自维护的 `auth.json`（可用 `CODEX_HOME` 覆盖目录）：

1. `tokens.access_token` — Bearer。长度不足 16 视为 malformed。
2. `tokens.account_id` — 绑定元数据。resolve 后经 lease / `snapshotFetchExtra` 交给 fetch，请求带 `chatgpt-account-id` 头。缺失时**不硬拒**，行为与原先相同（仅 Bearer）。
3. 该 `account_id` 按身份元数据处理：不进日志/诊断正文，usage envelope / `sourceStamp` 不得明文携带。账户变化走既有 generation / `scopeKey` 隔离，不同账户不得混用 last-good。

pi 兼容源仍可读 `openai-codex` 条目的 `accountId` / `account_id`，但不回滚用户已切到的 file 源。`OPENAI_API_KEY` 不是订阅凭证。

## 请求头（wham）

Codex CLI 调 wham 时除 `Authorization: Bearer` 外还带 `chatgpt-account-id`。OpenAI 端在 ChatGPT 账户会话下强制该头；缺头即 401，与 token 是否仍有效无关。

| Header | When |
| --- | --- |
| `Authorization: Bearer <access_token>` | always |
| `chatgpt-account-id: <account_id>` | resolve 提取到非空 `account_id` 时 |

## 口径说明（首发指标）

订阅窗口（primary/secondary 按响应 `limit_window_seconds`）、credits（有则显示）；used=原始 `used_percent`。官方 Web 另一聚合视图不在本层硬调。

## 401 / 风险

- HTTP 401 → `invalid-credential` / `http-401` / `relogin-owner`（映射不变）；至多同绑定源重读一次，不消费 borrowed refresh，不写回 `auth.json`。
- 社区内部接口；不绕 Cloudflare；网页独有口径另列未支持。

## Synthetic fixtures

`test/fixtures/providers/codex-auth-with-account.json`、`codex-auth-without-account.json`（合成 token / account_id，无真实凭证）。
