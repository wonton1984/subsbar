# cursor

> 状态：已实现（来源成熟度 C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

Cursor IDE state.vscdb（本地只读）+ usage-summary / Dashboard RPC

## 凭证方式

IDE state.vscdb 默认路径 ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb；Keychain 派生请求

## 口径说明（首发指标）

included 额度按套餐实报；onDemand 缺数据不编造；赠送额度保留 USD

## 风险与 403/异常处理

不混拼两账号 REST/RPC 结果；IDE 过期交原应用处理

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
