# grok

> 状态：计划中（来源成熟度 C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

cli-chat-proxy.grok.com/v1/billing?format=credits

## 凭证方式

GROK_HOME / ~/.grok/auth.json；过期运行 grok login

## 口径说明（首发指标）

共享 weekly/旧 monthly 按真实周期、PAYG cap

## 风险与 403/异常处理

不盲目轮换 token；WKE 缺失不能复制 cookie 修复

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
