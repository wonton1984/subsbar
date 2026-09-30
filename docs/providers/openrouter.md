# openrouter

> 状态：计划中（来源成熟度 A/B）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

openrouter.ai/api/v1/key（官方）；/credits 需 management key

## 凭证方式

普通 API key

## 口径说明（首发指标）

key quota 与分期消费；账户余额单独能力

## 风险与 403/异常处理

普通 key 403 时保留 key 数据、余额 unavailable；不把 key limit 冒充账户余额

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
