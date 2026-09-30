# 配置草案

> 状态：M0 草案。M1 引入 `~/.config/subsbar/config.json` 后以该文件为准；本文先行登记目标契约与现状。

## 现状（v0.1 候选）

| 环境变量 | 作用 |
| --- | --- |
| `PI_CODING_AGENT_DIR` | 缓存/状态目录覆盖（Node 与 Swift 必须一致；须为非空绝对路径） |
| `FACTORY_API_KEY` | Droid 凭证（或 Factory 加密文件 + Keychain） |
| `SUBS_BAR_PROJECT_DIR` | 开发裸进程运行原生 app 时定位 `scripts/subs.mjs` |
| `SUBS_BAR_SCRIPT_PATH` | 直接指定脚本路径 |

原生 app 偏好（UserDefaults `com.subsbar.native`）：`nativeNodePath`（显式 Node 绝对路径）、`nativeSelectedProvider`（选中 provider，稳定 ID）。

## 规划（M1，目标契约）

路径优先级：`--config <absolute-path>` → `SUBSBAR_CONFIG` → `${XDG_CONFIG_HOME}/subsbar/config.json` → 默认路径。仅展开 `~/` 前缀，不执行 shell 插值。

```jsonc
{
  "schemaVersion": 1,
  "runtime": { "nodePath": "auto", "refreshIntervalSeconds": 300, "timeoutSeconds": 15, "maxConcurrency": 3 },
  "privacy": { "allowBrowserDiscovery": false, "diagnostics": "local-redacted" },
  "ui": { "overviewMode": "cards", "menuBarMode": "single-pie", "pinnedMetrics": [], "selectedProvider": "codex" },
  "providers": {
    "codex": {
      "enabled": true,
      "activeProfile": "personal",
      "profiles": [{ "id": "personal", "discovery": "only", "allowKeychain": false, "allowBrowser": false,
        "sources": [{ "id": "codex-session", "kind": "cli", "reader": "codex-official" }] }]
    }
  }
}
```

规则：

- 配置里只放 secret 的**引用**（Keychain 服务/账户、env 名、文件路径），schema 拒绝 `token/apiKey/cookie` 明文字段。
- 未列 provider 一律 disabled；首次设置由用户显式启用。
- `discovery: "only"` 时只按列出来源顺序使用，显式来源无效即停止，不静默换账户。
- 浏览器来源不在默认链；如需（Devin 网页会话、Ollama 新账单），为手动导入到 SubsBar Keychain 的显式来源，单独开关。
- 刷新默认 300 秒，允许 provider 覆盖但不低于 adapter 公布的最小间隔；±10% jitter、单账户 single-flight、全局并发 3；尊重 Retry-After。
- 配置目录 0700 / 文件 0600；原子替换保存；Node 是配置校验真源（`config validate` / `config effective --json`）。

## 缓存与状态

- 缓存：`${agentDir}/subs-bar-cache.json`（现状；M1 起新安装默认 `${XDG_CACHE_HOME:-~/.cache}/subsbar/usage-v1.json`，迁移期双读）。
- 状态：`${agentDir}/subs-bar-state.json`（选中 provider，只存 id 字符串）。
- 缓存无 secrets，仍按私有文件处理（0600 语义）。
