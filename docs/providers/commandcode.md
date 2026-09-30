# commandcode

> 状态：已实现（来源成熟度 C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

api.commandcode.ai /alpha/whoami + billing/credits/subscriptions + usage/summary

## 凭证方式

专属 key / SubsBar Keychain / pi 兼显式来源

## 口径说明（首发指标）

月度 credits：有 summary → used=totalCost, limit=used+剩余；无 summary → 仅 remaining

## 风险与 403/异常处理

summary 缺失不虚构 used/limit；月度窗口倒计时来自订阅周期结束时间

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
