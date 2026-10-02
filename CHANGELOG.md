# Changelog

本文件从公开候选树（全新 git 历史）开始记录。私有开发阶段的历史不在此追溯。

## Unreleased（v0.1.0 候选）

### 已有
- 数据层（`scripts/subs.mjs` + `scripts/pie-png.mjs`）：Codex、OpenCode Go、Kimi Code、CommandCode、Factory Droid、Cursor 六家解析与缓存，零 npm 运行依赖。
- 原生 macOS 菜单栏 app（`macos-app/`）：Swift 6 + AppKit/NSStatusItem/NSPopover，单饼图图标、六家切换、诚实降级状态（仅余额 / 未知 / 过时 / 缺权限）。
- 离线测试：数据层边界与契约测试（合成 fixture，不触网）、Swift CoreChecks 契约套件。
- 公开卫生扫描器 `scripts/check-public.mjs`。

### 计划（首发 13 家 + Claude blocked）
- 新增 provider：GitHub Copilot、Z.AI/GLM、OpenRouter、Antigravity、Devin、Grok Build、Ollama Cloud。
- Claude 标 **blocked**（2026-10-02）：官方 CLI 2.1.285 无机读 usage 出口；不经手 token、不刮 TUI、不碰 OAuth/cookie。有机读出口再评估。
- 统一凭证抽象（env / 文件 / Keychain / CLI / 显式 pi 兼容）、`~/.config/subsbar/config.json` 配置、版本化报告协议（usage-v1）。
- 卡片式多 provider 同屏 UI、菜单栏固定指标。
