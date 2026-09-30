# SubsBar

macOS 菜单栏订阅额度面板 + 可独立运行的 Node 数据层。目标是在一个原生面板里完整覆盖你实际购买的 AI Coding 订阅，统一展示真实额度、余额与重置时间。

**状态：公开预览准备中（v0.1 目标 14 家 provider）。** 当前仓库为公开候选树：六家 provider（Codex / OpenCode Go / Kimi Code / CommandCode / Factory Droid / Cursor）已有本地实现与离线测试；其余八家为首发目标，尚未实现，不能视为已支持。

## 首发目标 provider（14 家）

| Provider | 状态 | 数据来源 |
| --- | --- | --- |
| Codex | 已实现 | OpenAI wham usage（社区内部接口） |
| OpenCode Go | 已实现 | `opencode.ai/zen/go/v1/usage` |
| Kimi Code | 已实现 | `api.kimi.com/coding/v1/usages` |
| CommandCode | 已实现 | `/alpha/whoami` + billing/usage |
| Factory Droid | 已实现 | organization subscription usage |
| Cursor | 已实现 | IDE state.vscdb + usage-summary RPC |
| Claude | 计划中 | 官方 CLI `/usage` 优先；OAuth 来源待准入审阅 |
| GitHub Copilot | 计划中 | 官方 Copilot 能力优先；内部接口为社区来源 |
| Z.AI / GLM Coding Plan | 计划中 | quota/limit 接口（社区来源） |
| OpenRouter | 计划中 | `/api/v1/key`（官方） |
| Antigravity | 计划中 | 官方 `agy /usage` 优先 |
| Devin | 计划中 | CLI 凭证 / app DB / 手动导入网页会话 |
| Grok Build | 计划中 | `cli-chat-proxy.grok.com/v1/billing` |
| Ollama Cloud | 计划中 | 本地签名请求（`~/.ollama/id_ed25519`） |

每家的来源等级、凭证方式、窗口口径与已知缺口见 `docs/providers/<id>.md`。社区内部接口的 adapter 默认关闭，启用前请阅读对应文档与适用服务条款。

## 安装（公开预览）

首发分发形式为**源码 + 外部 Node**（≥22），不含签名公证的 DMG。

1. 安装 Node.js ≥ 22；
2. 克隆仓库后 `node scripts/subs.mjs --refresh` 生成缓存（需要本机已有对应 provider 的登录凭证或 API key）；
3. 原生 app 构建见 `macos-app/`（Swift 6 / SwiftPM，`swift build` + `./build-app.sh`）。

各 provider 的凭证发现方式（env / 文件 / Keychain / CLI 会话）与优先级见 `docs/configuration.md`。

## 口径差异说明（重要）

不同 provider 的 API 给出的字段不一致，SubsBar 不做补造：

- 有的窗口只有 `used/limit`，有的只有余额（`remaining`）。只有余额时不编造分母，显示「剩 $x」而非「$0 / $x」。
- `resetsAt` 为秒、`fetchedAt` 为毫秒；窗口未激活（`resetsAt: 0`）显示「重置时间未知」，不猜测。
- 超额数字保留原值，仅绘图裁剪到 0–100%；`0` 与「未知」严格区分。
- requests、tokens、credits、USD 等不同单位绝不相加。
- 缓存 ≤10 分钟视为新鲜，>10 分钟标记过时，≥24 小时显示历史数据并灰化图标。

## 免责声明

SubsBar 是独立社区项目，与列出的 AI 服务商不存在官方合作或背书。它仅展示您选择的数据源提供的账户用量、限额或余额；数据可能延迟、缺失或因服务变化停止可用，请以服务商官方账单和控制台为准。部分数据源使用未公开的接口，启用前请阅读对应 provider 文档及适用服务条款。SubsBar 不提供绕过访问控制或额度限制的功能。凭证仅在本机用于对应服务商的请求，不上传至项目服务器；诊断和缓存不应包含凭证。软件按 LICENSE 的原样条款提供。

## 开发

```sh
node test/edge.test.mjs         # 数据层离线边界测试
node test/droid-cursor.test.mjs # droid/cursor/codex/commandcode 契约测试
swift build --package-path macos-app
swift run --package-path macos-app CoreChecks
node scripts/check-public.mjs   # 公开卫生扫描（secret/PII/路径）
```

全部离线测试使用合成 fixture，不触网、不读真实凭证。许可证见 LICENSE；移植代码的来源与许可账本见 THIRD_PARTY_NOTICES.md。
