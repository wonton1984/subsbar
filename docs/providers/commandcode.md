# commandcode

> 状态：已实现（来源成熟度 C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

api.commandcode.ai /alpha/whoami + billing/credits/subscriptions + usage/summary

## 凭证方式

专属 key / SubsBar Keychain / pi 兼显式来源

## 口径说明（首发指标）

月度 credits：有 summary → used=totalCost, limit=used+剩余；无 summary → 仅 remaining

## 风险与 403/异常处理

summary 缺失不虚构 used/limit；月度窗口倒计时来自订阅周期结束时间。

fetch 失败必须区分：`timeout`（本地/上游超时）、`connect-refused`（连接失败）、`http-5xx`（服务端 5xx，带 httpStatus）。不得把 timeout 标成 `http-5xx`。

## 超时预算（2026-09-30 实测）

未鉴权 `GET /alpha/whoami` 约 760ms 返回 403，源站可达。旧实现用 15s AbortController 包住 whoami + credits/subscriptions + summary 三轮，慢响应会被打成 timeout。现为：单请求 20s、整次任务 60s（manifest `taskTimeoutSeconds` 75，给 scheduler 外层留余量）；仅当首次失败为 timeout 且耗时 ≤35s 时整次重试一次。

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
