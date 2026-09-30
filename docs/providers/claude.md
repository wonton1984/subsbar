# claude

> 状态：计划中（来源成熟度 D（M1 准入））。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

优先原版 Claude Code CLI /usage；OAuth 来源待准入审阅

## 凭证方式

官方 CLI 优先（SubsBar 不经手 token）；Keychain/文件候选需政策审阅

## 口径说明（首发指标）

Pro/Max session/weekly/模型窗口

## 风险与 403/异常处理

官方限制第三方收集会话凭证；未找到合规来源即首发阻断，不用 cookie 规避

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
