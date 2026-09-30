# opencode

> 状态：已实现（来源成熟度 C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

opencode.ai/zen/go/v1/usage

## 凭证方式

Go 专属 key / OpenCode auth 文件 / pi 兼显式来源；不需浏览器

## 口径说明（首发指标）

session/weekly/monthly 按响应

## 风险与 403/异常处理

403 EntitlementError 表示无 Go 资格；Zen 本地 spend 非首发指标

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
