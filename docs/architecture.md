# 架构草案

> 状态：M0 草案，随 M1/M2 实施修订。

## 总览

```
┌─────────────────────────────────────────────┐
│  macOS 原生 app（macos-app/）                │
│  SubsBar (NSStatusItem + NSPopover)          │
│    ├── SubsCore: 缓存解析 / Node 定位 /      │
│    │             刷新契约 / 取消            │
│    └── SubsBar: 图标渲染 / 弹窗 UI / 状态    │
└──────────────┬──────────────────────────────┘
               │ 读取 subs-bar-cache.json（只读）
               │ 启动 node subs.mjs --refresh
┌──────────────▼──────────────────────────────┐
│  Node 数据层（scripts/subs.mjs，零 npm 依赖）│
│    ├── providers: 每家 fetch + normalize     │
│    ├── 缓存（原子写 + 进程内锁）             │
│    └── 凭证：只读本机来源，绝不输出 secret    │
└─────────────────────────────────────────────┘
```

## 数据层

- 单文件 `scripts/subs.mjs` + `scripts/pie-png.mjs`（纯 zlib PNG 生成）。零 npm 运行依赖是刻意取舍：无供应链面、可审计。
- 每家 provider 实现为 `fetchUsage`（HTTP/进程/文件）+ `normalize`（响应 → 统一 report 模型：`windows[]` / `metrics[]` / `notes[]`）。
- M1 计划拆分为 `core/` 模块结构（providers/、credentials/、runtime/、config/），`scripts/subs.mjs` 保留为 CLI/JSON 兼容入口。拆分后单文件交付不再承诺。

## 原生 app

- Swift 6 + AppKit 生命周期（NSApplication accessory）、NSStatusItem、NSPopover + SwiftUI 内容。
- app **只读**缓存文件，刷新通过子进程调用 `node subs.mjs --refresh`（参数数组，无 shell 拼接，stdout/stderr 丢弃）。
- Node 定位：显式 `nativeNodePath` → `/opt/homebrew/bin/node` → `/usr/local/bin/node` → PATH；要求 ≥22，版本探测有界（3 秒超时、64 KiB 输出上限）。
- 刷新契约：`--refresh` exit 0 不是成功证据；逐家比较 fetchedAt，仅新增有效时间戳算「已更新」。
- 并发保护：flock 单实例锁；快照合并拒绝旧时间戳回写（rollback 保护）；睡眠唤醒合并刷新。

## 数据契约

- 缓存根是 provider id → `{fetchedAt(毫秒), report:{capturedAt(毫秒), windows[], metrics[], notes[]}}` 的映射，无外壳。
- 窗口字段：`id/label/used/remaining/limit/unit(percent|usd|count)/resetsAt(秒)/primary/windowMinutes`。
- 语义基线：
  - 未知字段省略；`0` 保留且与「未知」严格区分；
  - 仅余额（remaining-only）不推导 used/limit/百分比；
  - 超额原值保留，绘图裁剪 0–100%；
  - 不同单位（requests/tokens/credits/USD/CNY）绝不相加；
  - `resetsAt: 0` = 窗口未激活 → 显式「重置时间未知」。
- 新鲜度：≤10 分钟 fresh，>10 分钟 stale，≥24 小时 expired（图标灰），未来时间 >5 分钟 invalid。

## 凭证（现状与规划）

现状：凭证由 pi auth（`~/.pi/agent/auth.json`）或各家原生来源（`FACTORY_API_KEY`、Cursor IDE state.vscdb、Keychain 等）提供，数据层只读。

规划（M1）：统一 credential resolver（env / 具名文件 / 精确 Keychain 项 / CLI 会话 / 显式 pi 兼容），见 README 与 `docs/configuration.md`。所有权规则：`borrowed` 凭证不消费 refresh token、不写第三方文件；`subsbar` 凭证仅存本项目 Keychain。详见 SECURITY 计划（M3 文档）。

## 测试

- `test/edge.test.mjs`：渲染/JSON 契约边界（合成 fixture）。
- `test/droid-cursor.test.mjs`：droid/cursor/codex/commandcode 解析与降级契约（合成 fixture）。
- `swift run CoreChecks`（macos-app/）：91 项 Swift 契约检查（解码、比例、新鲜度、选择、IO、缓存回退、刷新契约、超时取消）。
- 在线冒烟不入默认测试入口；CI 一律离线。
