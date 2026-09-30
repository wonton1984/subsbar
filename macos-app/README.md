# SubsBar 原生 macOS 菜单栏应用

SwiftPM / Swift 6 + AppKit 生命周期、NSStatusItem、NSPopover 和 SwiftUI。菜单栏仅一个彩色余量饼图，点击打开详情，内部真按钮切换，外点/Esc/再次点击关闭。完整 `.app` 无 Dock 图标。

## 构建与运行

```sh
cd macos-app
swift build
swift run CoreChecks
./build-app.sh
open dist/SubsBar.app
```

部署基线 macOS 13（Apple Silicon 优先）。需要外部 Node ≥ 22（自动探测 `/opt/homebrew/bin/node`、`/usr/local/bin/node` 及 PATH）。当前 CI 验证范围见仓库 Actions 配置；未验证的系统版本不承诺支持。

产物 `dist/SubsBar.app` 包含 Info.plist（`com.subsbar.native`、LSUIElement）、可执行文件及构建时**原样复制**的 `subs.mjs`、`pie-png.mjs`（经 `SUBS_BAR_PROJECT_DIR` 指向 bundle 资源目录），并记录资源哈希。构建末尾 ad-hoc 签名、严格校验。无需 Xcode 工程、登录 shell 或启动工作目录；不是 Developer ID 公证分发包。更新数据桥后需重建 app。

### 安装和登录时启动

退出旧实例后，将 `dist/SubsBar.app` 拷到 `~/Applications/`。Finder 双击或 `open ~/Applications/SubsBar.app` 启动。应用持有 flock 实例锁，重复启动不会生成第二个状态图标。

在系统设置 → 通用 → 登录项 → 登录时打开中添加已安装的 SubsBar.app。取消自启时从列表移除。不会新增 LaunchAgent，也不实现 ServiceManagement。退出使用 popover 底部"退出"。

## 数据契约与选择

数据层（`scripts/subs.mjs`）把缓存写到 `${PI_CODING_AGENT_DIR}`（默认 `~/.pi/agent`）下的 `subs-bar-cache.json`，选择状态写 `subs-bar-state.json`。原生 app 只读缓存，不写回、不调用 `--select`。如配置 `PI_CODING_AGENT_DIR`，须为非空绝对目录，Node 和 Swift 使用同一目录。原生偏好在 UserDefaults `com.subsbar.native`，优先采用 `nativeSelectedProvider`；首次无原生选择时继承共享状态的 provider 稳定 ID，之后独立持久化。

缓存根直接是 provider 映射，无 providers 外壳；`fetchedAt`/`capturedAt` 毫秒，`resetsAt` 秒。后台读取最多 1 MiB，短暂错误重试，逐家/逐行容错，保留且标记 last-known；不读取 auth/token。文本清洗并限制长度。缺字段显示未知，bool/负数/非有限数无效；支持十进制字符串。

主窗口优先第一个 primary，否则第一个有效 used，再否则第一行。percent 的 used 是百分比；其他单位用 used/limit。有 used 时 remaining 不覆盖它，仅 remaining 且 limit 有效才推导已用。超额数字保持真实，绘图裁剪到 0–100%。

图标和标题为剩余；进度条为已用。>50% 绿，20–50% 橙，<20% 红，无有效数据灰色短横。0% 红空轮廓、100% 满圆。1x/2x 手绘，非模板图。缓存 ≤10 分钟正常，>10 分钟且 <24 小时过时，≥24 小时历史数据且图标灰；未来超过 5 分钟的时间为异常。倒计时归零仅提示等待更新，不将额度清零。

## 各 provider 展示语义

- Droid：滚动 5h/周/月及标准总额度，primary 由 5h 决定；仅有总额度时显示滚动窗口缺失提示。
- Codex：标签按响应实际时长显示（如 10080 分钟 → 「周主窗口」），不硬编码 5h。
- CommandCode：月度倒计时来自订阅周期结束时间，未激活的滚动窗口不编造倒计时；summary 缺失时显示仅余额「剩 $x」，不输出误导的 used/limit。
- Cursor：没有 onDemand 数据时不编造额度行，赠送额度保留 USD。
- 六家缺缓存均显示"暂无可用缓存"，不推断未登录。

## 刷新边界

启动先读缓存，缺失/超过 5 分钟时后台尝试；300 秒 common-mode timer、手动刷新及唤醒合并到单次任务。刷新不清空旧 UI；切换不会触发 API。popover 打开仅重读，倒计时只在可见时 tick；每分钟检查图标新鲜度。

Node 顺序：显式 `nativeNodePath` → `/opt/homebrew/bin/node` → `/usr/local/bin/node` → PATH 中绝对路径；有界版本探测要求 ≥22。显式配置错误不静默回退：

```sh
defaults write com.subsbar.native nativeNodePath '/absolute/path/to/node'
# 恢复自动探测：
defaults delete com.subsbar.native nativeNodePath
```

修改后重启应用。Process 用参数数组 `[scriptURL.path, "--refresh"]`，不做 shell 拼接；120 秒总上限，超时/退出取消只结束自己启动的子进程并回收。刷新 stdout/stderr 接 `/dev/null`，不记录原始输出或凭证。开发裸进程须显式指定 `SUBS_BAR_PROJECT_DIR`，发布 app 用 bundle 资源。

`--refresh` exit 0 **不是成功证据**。逐家比较有效 fetchedAt：新增有效时间戳为已更新，未变化提示"本次未获得新数据，显示缓存；具体接口原因不可用"。本地启动/超时/退出码/缓存错误可显示具体原因。

## 测试

当前 CLT 不含 XCTest 时，`swift run CoreChecks` 运行共享测试套件；完整 Xcode 环境可运行 `SUBSBAR_XCTEST=1 swift test`，调用同一套断言。CoreChecks 非无断言冒烟，失败会非零退出，覆盖解码、比例、新鲜度、选择、IO、缓存回退、刷新无更新/部分更新、空间路径、满输出、非零退出、超时强杀、取消回收。

隔离 UI fixture（合成数据，无认证文件）：

```sh
python3 Tests/Fixtures/make-fixture.py "/tmp/SubsBar UI fixtures"
open --env "PI_CODING_AGENT_DIR=/tmp/SubsBar UI fixtures" dist/SubsBar.app
```

fixture 无认证文件；不能用它判断真实 API 已接入。
