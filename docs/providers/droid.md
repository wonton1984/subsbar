# droid

> 状态：已实现（来源成熟度 C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

Factory organization subscription usage

## 凭证方式

FACTORY_API_KEY / ~/.factory/.env / Factory 加密文件+精确 Keychain 项

## 口径说明（首发指标）

滚动 5h/周/月 + 标准总额度；primary=5h 滚动窗

## 风险与 403/异常处理

403 manager 错误可能为缺 self userId，非 token 过期；不绕组织权限

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
