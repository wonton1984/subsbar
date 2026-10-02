# THIRD_PARTY_NOTICES

本仓库包含从下列项目移植的代码。各来源均按其原始许可证（MIT）授权使用；本仓库以 MIT 发布。若原始版权声明与本文有出入，以原始仓库为准。

| 来源 | URL / 版本 | 许可证 | 本仓对应文件 | 修改说明 |
| --- | --- | --- | --- | --- |
| @narumitw/pi-usage | https://github.com/narumiruna/pi-extensions （monorepo，参考版本 v0.61.1；kimi/opencode/codex 响应解析） | MIT | `scripts/subs.mjs`（kimi / opencode / codex 解析函数） | TypeScript 移植为 JavaScript；字段解析逻辑重写以适配本仓窗口/指标模型；未复制 UI 代码 |
| pi-commandcode-provider | https://github.com/patlux/pi-commandcode-provider v0.6.4（commandcode 响应解析与月度语义） | MIT | `scripts/subs.mjs`（commandcode 解析函数） | TypeScript 移植为 JavaScript；补充 summary 缺失时仅 remaining 的降级路径 |
| pi-subs | 维护者私有参考实现（未公开）。移植链上游为 @narumitw/pi-usage（MIT），归因由上行承载 | MIT | `core/providers/engine/`（含 m2-providers.mjs） | 移植并扩展：droid/cursor 新增、月度语义修正、仅余额降级契约、窗口标签按真实时长；M2-A/B 移植 claude/copilot/zai/openrouter 四家解析（TS→JS，v1 归一化：不 clamp、缺失即 unknown）。M2-B：Copilot 仅接受 OAuth 类型；Z.AI region 分 origin 不互探；OpenRouter 主路径 `/api/v1/key`，`/credits` 需 management key 未并入 refresh 链。M2-C：Antigravity/Devin/Grok 凭证分流与防御性解析（未复制 OpenUsage/CodexBar 代码；协议仅参考公开文档）。M2-D：Ollama 签名 GET /api/usage（手写 OpenSSH Ed25519 + JWK；未复制官方 Go 源码）。Claude 官方 CLI 无非交互机读配额，本批未实现。 |

> 仅"参考协议/交互"而未复制代码的来源（CodexBar、OpenUsage、OpenUsageCN 的公开文档）不列入本表，记录于 `docs/providers/` 各文件的来源段。

## 许可证边界

- 本项目主许可证为 MIT。上游存在 NOTICE 或 Apache-2.0 代码时按要求单独保留许可文本，不抹成 MIT（如 Z.AI 官方插件为 Apache-2.0，本仓对其仅有协议参考、无代码复制，不产生 NOTICE 义务）。
- 各 provider 的数据接口可用性由服务商决定；本项目引用其接口不构成服务商授权，也不传递任何商标或品牌权利。
