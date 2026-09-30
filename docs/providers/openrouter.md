# openrouter

> 状态：计划中（来源成熟度 A/B）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

> **验证状态**：结构已防御性实现（解析器在本仓并有合成 fixture 测试）；维护者本机无此订阅，未经真实端点验证——字段名可能偏差。欢迎社区贡献者以真实账号验证并回馈字段级结论。

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
