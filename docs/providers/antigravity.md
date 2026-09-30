# antigravity

> 状态：计划中（来源成熟度 C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

优先已登录 agy 官方 /usage；本地 language server（C）

## 凭证方式

agy CLI 输出 → 验证后本地 API；Keychain OAuth 仅准入后

## 口径说明（首发指标）

Gemini 与非 Gemini 池及服务端实际返回窗口

## 风险与 403/异常处理

不触发 onboarding/推理副作用；403 保留错误不当作满额度

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。
