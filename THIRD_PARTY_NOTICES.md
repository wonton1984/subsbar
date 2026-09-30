# THIRD_PARTY_NOTICES

本仓库包含从下列项目移植的代码。各来源均按其原始许可证（MIT）授权使用；本仓库以 MIT 发布。若原始版权声明与本文有出入，以原始仓库为准。

| 来源 | URL / 版本 | 许可证 | 本仓对应文件 | 修改说明 |
| --- | --- | --- | --- | --- |
| @narumitw/pi-usage | https://github.com/narumiruna/pi-extensions （monorepo，参考版本 v0.61.1；kimi/opencode/codex 响应解析） | MIT | `scripts/subs.mjs`（kimi / opencode / codex 解析函数） | TypeScript 移植为 JavaScript；字段解析逻辑重写以适配本仓窗口/指标模型；未复制 UI 代码 |
| pi-commandcode-provider | https://github.com/patlux/pi-commandcode-provider v0.6.4（commandcode 响应解析与月度语义） | MIT | `scripts/subs.mjs`（commandcode 解析函数） | TypeScript 移植为 JavaScript；补充 summary 缺失时仅 remaining 的降级路径 |
| pi-subs | 维护者私有参考实现（未公开）。移植链上游为 @narumitw/pi-usage（MIT），归因由上行承载 | MIT | `scripts/subs.mjs`（解析适配与窗口/指标模型扩展） | 移植并扩展：droid/cursor 新增、月度语义修正、仅余额降级契约、窗口标签按真实时长 |

> 仅"参考协议/交互"而未复制代码的来源（CodexBar、OpenUsage、OpenUsageCN 的公开文档）不列入本表，记录于 `docs/providers/` 各文件的来源段。

## 许可证边界

- 本项目主许可证为 MIT。上游存在 NOTICE 或 Apache-2.0 代码时按要求单独保留许可文本，不抹成 MIT（如 Z.AI 官方插件为 Apache-2.0，本仓对其仅有协议参考、无代码复制，不产生 NOTICE 义务）。
- 各 provider 的数据接口可用性由服务商决定；本项目引用其接口不构成服务商授权，也不传递任何商标或品牌权利。
