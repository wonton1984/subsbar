# ollama

> 状态：计划中（来源成熟度 D（M1 探测））。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

签名 GET ollama.com/api/usage、POST /api/me

## 凭证方式

~/.ollama/id_ed25519 + ollama signin 的本机签名（request-signer）

## 口径说明（首发指标）

quota 按真实 monthly 或 session/weekly 显示，不猜 reset

## 风险与 403/异常处理

签名格式兼容性待验证；普通 OLLAMA_API_KEY 验证不能替代 quota

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
