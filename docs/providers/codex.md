# codex

> 状态：已实现（来源成熟度 A→C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

Codex CLI 会话 / wham usage 内部接口（社区来源）

## 凭证方式

Codex CLI 登录会话；pi 兼容显式来源；OPENAI_API_KEY 不作订阅凭证

## 口径说明（首发指标）

订阅窗口（primary/secondary 按响应 limit_window_seconds）、credits（有则显示）；used=原始响应值

## 风险与 403/异常处理

社区内部接口；不绕 Cloudflare；网页独有口径另列未支持

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
