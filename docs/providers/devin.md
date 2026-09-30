# devin

> 状态：计划中（来源成熟度 C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

> **验证状态**：结构已防御性实现（解析器在本仓并有合成 fixture 测试）；维护者本机无此订阅，未经真实端点验证——字段名可能偏差。欢迎社区贡献者以真实账号验证并回馈字段级结论。

## 数据来源

CLI credentials.toml / app DB / app.devin.ai 组织 quota（网页需会话）

## 凭证方式

windsurf_api_key 或 app DB；网页路径手动导入会话+org ID 到 Keychain

## 口径说明（首发指标）

按实际套餐 daily/weekly/extra balance

## 风险与 403/异常处理

CLI 成功但非目标组织额度不算完成；禁止跨账户 fallback

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
