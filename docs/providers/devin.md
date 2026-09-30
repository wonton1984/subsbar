# devin

> 状态：计划中（来源成熟度 C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

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
