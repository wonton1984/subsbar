import AppKit
import SwiftUI
import SubsCore

@MainActor func record(_ value: String) { NSLog("SubsBar %@", value) }
@MainActor final class AppModel: ObservableObject {
    @Published var snapshot = Snapshot()
    @Published var selected = "codex"
    @Published var refreshing = false
    @Published var outcomes: [String: String] = [:]
    @Published var globalError: String?
    @Published var now = Date()
    @Published var visible = false
    @Published var height: CGFloat = 300
    var detailsHeight: CGFloat?
    func measureDetails(_ value: CGFloat) {
        guard value.isFinite, value > 0, abs((detailsHeight ?? 0) - value) > 0.5 else { return }
        detailsHeight = value
        changed?()
    }
    var changed: (() -> Void)?
    private let queue = DispatchQueue(label: "com.subsbar.native.io", qos: .utility)
    private let defaults = UserDefaults.standard
    private let paths: DataPaths?
    private var loaded = false
    private var reading = false
    private var stopping = false
    private var timers: [Timer] = []
    private var countdownTimer: Timer?
    private var wake: NSObjectProtocol?
    private var lastAttempt: Date?
    private var cancellation = Cancellation()
    var entry: Entry? { snapshot.entries[selected] }
    var provider: Provider { Provider.all.first(where: { $0.id == selected })! }
    var fraction: Double? { provider.supported ? entry?.iconFraction(at: now) : nil }
    var cacheStatus: String {
        guard provider.supported else { return "未接入" }
        guard let entry else { return "暂无可用缓存" }
        return entry.freshness(at: now).rawValue
    }
    var tooltip: String { "\(provider.name) · 剩余 \(fraction.map { Cache.format($0 * 100) + "%" } ?? "未知") · \(cacheStatus)\(snapshot.error == nil && snapshot.diagnostics[selected] == nil ? "" : " · 上次数据")" }
    init() {
        do { paths = try DataPaths() } catch { paths = nil; globalError = String(describing: error) }
    }
    func start() {
        readCache(initial: true)
        timer(300) { model in model.refresh() }
        timer(60) { model in model.now = Date(); model.changed?() }
        wake = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.now = Date(); self.changed?()
                if Date().timeIntervalSince(self.lastAttempt ?? .distantPast) >= 300 { self.refresh() }
            }
        }
    }
    private func timer(_ interval: TimeInterval, action: @escaping @MainActor (AppModel) -> Void) {
        let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { if let self, !self.stopping { action(self) } }
        }
        RunLoop.main.add(t, forMode: .common); timers.append(t)
    }
    func choose(_ id: String) {
        selected = id; defaults.set(id, forKey: "nativeSelectedProvider"); changed?()
        record("selected=\(id)")
    }
    func setVisible(_ value: Bool) {
        visible = value
        countdownTimer?.invalidate(); countdownTimer = nil
        if value {
            now = Date(); readCache()
            let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.now = Date() } }
            RunLoop.main.add(t, forMode: .common); countdownTimer = t
        }
    }
    func readCache(initial: Bool = false) {
        guard let paths, !reading, !stopping else { return }
        reading = true
        queue.async { [weak self] in
            let result = CacheReader.read(paths)
            DispatchQueue.main.async {
                guard let self else { return }
                self.reading = false
                guard !self.stopping else { return }
                self.snapshot = self.snapshot.merging(result)
                self.now = Date()
                if !self.loaded {
                    self.selected = Cache.selection(native: self.defaults.string(forKey: "nativeSelectedProvider"), shared: result.shared, entries: result.entries, now: self.now)
                    self.loaded = true
                }
                self.changed?()
                record("cache read providers=\(result.entries.count) selected=\(self.selected) remaining=\(self.fraction.map { Cache.format($0 * 100) } ?? "unknown")")
                if initial && Provider.all.filter(\.supported).contains(where: { (result.entries[$0.id]?.fetchedAt ?? .distantPast) < self.now.addingTimeInterval(-300) }) { self.refresh() }
            }
        }
    }
    func refresh() {
        guard !refreshing, !stopping, let paths else { return }
        refreshing = true; lastAttempt = Date()
        let before = snapshot
        let token = Cancellation(); cancellation = token
        let nodePath = defaults.string(forKey: "nativeNodePath")
        let script: URL?
        if let resources = Bundle.main.resourceURL, Bundle.main.bundleURL.pathExtension == "app" {
            script = resources.appendingPathComponent("scripts/subs.mjs")
        } else if let root = ProcessInfo.processInfo.environment["SUBS_BAR_PROJECT_DIR"], root.hasPrefix("/") {
            script = URL(fileURLWithPath: root).appendingPathComponent("scripts/subs.mjs")
        } else { script = nil }
        queue.async { [weak self] in
            var failure: String?
            var conflict = false
            let deadline = ProcessInfo.processInfo.systemUptime + 120
            do {
                conflict = LegacyRefreshGuard.conflict(cancellation: token)
                if conflict { throw LocalFailure("检测到旧版 com.subsbar.refresh LaunchAgent（历史版本遗留）；请先停用它再刷新") }
                guard let script, FileManager.default.isReadableFile(atPath: script.path) else { throw LocalFailure("脚本缺失；请运行完整 .app，开发运行需 SUBS_BAR_PROJECT_DIR") }
                let node = try NodeLocator.locate(explicit: nodePath, cancellation: token)
                var environment = ProcessInfo.processInfo.environment
                environment["PI_CODING_AGENT_DIR"] = paths.agent.path
                environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (environment["PATH"] ?? "")
                let result = ProcessRunner.run(executable: node, arguments: [script.path, "--refresh"], directory: script.deletingLastPathComponent().deletingLastPathComponent(), environment: environment, timeout: max(0, deadline - ProcessInfo.processInfo.systemUptime), cancellation: token)
                failure = result.failure
                DispatchQueue.main.async { record("refresh process pid=\(result.pid ?? -1) exit=\(result.status ?? -1) cancelled=\(token.cancelled)") }
            } catch { failure = String(describing: error) }
            let after = CacheReader.read(paths)
            let results = RefreshContract.outcomes(before: before, after: after, failure: failure)
            let finalFailure = failure
            let blocked = conflict
            DispatchQueue.main.async {
                guard let self else { return }
                self.refreshing = false
                if self.stopping { NSApp.reply(toApplicationShouldTerminate: true); return }
                self.snapshot = self.snapshot.merging(after); self.now = Date()
                self.globalError = blocked ? finalFailure : nil
                self.outcomes = results
                self.changed?()
                record("refresh finished updated=\(results.values.filter { $0 == "已更新" }.count) / \(Provider.all.filter(\.supported).count)\(blocked ? " legacy-launchagent-blocked" : "")")
            }
        }
    }
    func stop() -> Bool {
        stopping = true; timers.forEach { $0.invalidate() }; countdownTimer?.invalidate()
        if let wake { NSWorkspace.shared.notificationCenter.removeObserver(wake) }
        cancellation.cancel()
        return refreshing
    }
}
