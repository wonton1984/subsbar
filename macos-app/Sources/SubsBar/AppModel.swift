import AppKit
import SwiftUI
import SubsCore

@MainActor func record(_ value: String) { NSLog("SubsBar %@", value) }
@MainActor final class AppModel: ObservableObject {
    @Published var document: ConfigDocument?
    @Published var registry: Wire = .null
    @Published var usage: UsageV1?
    @Published var refreshing = false
    @Published var saving = false
    @Published var loading = false
    @Published var globalError: String?
    @Published var now = Date()
    @Published var height: CGFloat = 300
    @Published var receipt: String?
    @Published var expandedOverrides: [String: Bool] = [:]
    @Published var addSubscriptionExpanded = false
    @Published var guideOpen: Set<String> = []
    @Published var keyError: String?
    @Published var keySaving = false
    var credentialWriter = CredentialWriter(store: SecurityKeychainStore())
    private var pendingConnect: String?
    var detailsHeight: CGFloat?
    var chromeHeight: CGFloat?
    var changed: (() -> Void)?
    var openSettings: ((String?) -> Void)?
    private var bridge: NodeBridge?
    private var generation = 0
    private var stopping = false
    private var cancellation = Cancellation()
    private var activeCalls: [UUID: Cancellation] = [:]
    private var startedRefresh = false
    private var timer: Timer?
    private var clock: Timer?
    private var countdown: Timer?
    private var wake: NSObjectProtocol?
    var config: Wire { document?.config ?? .null }
    var selected: String { config["ui"]["selectedProvider"].text }
    var entry: V1Provider? { usage?.providers.first { $0.id == selected } }
    var fraction: Double? { entry?.iconFraction(at: now) }
    var tooltip: String {
        let stale = entry.map { $0.freshness(at: now) != "fresh" && $0.report.isObject } ?? false
        return "SubsBar · \(name(selected)) · 剩余 \(fraction.map { Cache.format($0 * 100) + "%" } ?? "未知") · \(Presentation.status(entry?.status ?? "disabled"))" + (stale ? " · 上次数据" : "")
    }
    var providers: [Wire] {
        let all = registry["providers"].array
        let order = config["ui"]["providerOrder"].array.map(\.text)
        return all.sorted { (order.firstIndex(of: $0["providerId"].text) ?? 999) < (order.firstIndex(of: $1["providerId"].text) ?? 999) }
    }
    var enabled: [Wire] { providers.filter { config["providers"][$0["providerId"].text]["enabled"].bool } }
    var sections: ProviderSections { ProviderSections(registry: registry["providers"].array, config: config) }
    func name(_ id: String) -> String { Presentation.text(providers.first { $0["providerId"].text == id }?["name"].text ?? (id.isEmpty ? "选择订阅" : id)) }
    func supported(_ id: String) -> Bool { providers.first { $0["providerId"].text == id }?["supported"].bool ?? false }
    /// Click-to-expand is session state; `ui.cards[id].expanded` stays the persisted default.
    func isExpanded(_ id: String) -> Bool { expandedOverrides[id] ?? config["ui"]["cards"][id]["expanded"].bool }
    func toggleExpanded(_ id: String) { expandedOverrides[id] = !isExpanded(id); changed?() }
    func toggleAddSubscription() { addSubscriptionExpanded.toggle(); changed?() }
    func toggleGuide(_ id: String) {
        if guideOpen.contains(id) { guideOpen.remove(id) } else { guideOpen.insert(id) }
    }
    /// Saves a pasted API key to SubsBar's own Keychain item, then runs the normal connection check.
    /// The key is never stored on the model, logged or cached; only a fixed-text error is kept.
    func saveKey(guide: ConnectionGuide, base: ConfigDocument, draft: Wire, profileID: String, key: String) {
        guard !keySaving, !saving, !refreshing, !stopping else { return }
        keySaving = true; keyError = nil
        let writer = credentialWriter
        Task {
            defer { keySaving = false }
            do {
                let updated = try CredentialWriter.connectionDraft(draft, guide: guide, profileID: profileID)
                try await Task.detached { try writer.save(guide: guide, profileID: profileID, key: key) }.value
                guard !stopping else { return }
                pendingConnect = guide.providerID
                save(base: base, patch: .object(["providers": .object([guide.providerID: updated])])) { [weak self] ok in
                    if !ok { self?.pendingConnect = nil; self?.keyError = "密钥已存入钥匙串，但连接配置未保存。请重新载入配置后重试。" }
                }
            } catch {
                keyError = String(describing: error) == "credential-invalid" ? "密钥格式不对，请重新粘贴" : "无法保存到钥匙串，请检查授权后重试"
            }
        }
    }
    /// "I'm done logging in": enable the provider if needed, then check only this provider.
    /// The check waits for the config reload so it sees the enabled provider.
    func connect(provider id: String, base: ConfigDocument, draft: Wire) {
        guard !keySaving, !saving, !refreshing, !stopping else { return }
        var patch = Wire.object([:])
        if hasPiReader(id) && !config["compatibility"]["pi"]["enabled"].bool {
            patch = patch.setting("compatibility", config["compatibility"].setting("pi", config["compatibility"]["pi"].setting("enabled", .bool(true))))
        }
        if config["providers"][id]["enabled"].bool && draft == config["providers"][id] {
            if patch["compatibility"].isObject {
                pendingConnect = id
                save(base: base, patch: patch) { [weak self] ok in if !ok { self?.pendingConnect = nil } }
            } else {
                refresh(provider: id, connect: true)
            }
            return
        }
        var connection = draft
        if connection["profiles"].array.isEmpty {
            let profileID = "profile-" + String(UUID().uuidString.lowercased().prefix(8))
            let profile = Wire.object(["id": .string(profileID), "discovery": .string("auto"), "allowKeychain": .bool(false), "allowBrowser": .bool(false), "allowLocalApi": .bool(false), "sources": .array([])])
            connection = connection.setting("profiles", .array([profile])).setting("activeProfile", .string(profileID))
        }
        pendingConnect = id
        save(base: base, patch: patch.setting("providers", .object([id: connection.setting("enabled", .bool(true))]))) { [weak self] ok in
            if !ok { self?.pendingConnect = nil }
        }
    }
    private func hasPiReader(_ id: String) -> Bool {
        providers.first { $0["providerId"].text == id }?["credentialReaders"].array.contains { $0["kind"].text == "pi" && $0["implemented"].bool } ?? false
    }
    func card(_ id: String, single: Bool) -> CardModel {
        CardModel(providerID: id, name: name(id), config: config, usage: usage, now: now, expanded: single || isExpanded(id))
    }
    var menuBarIDs: [String] {
        MenuBarSelection.visible(ui: config["ui"], ordered: providers.map { $0["providerId"].text }, enabled: enabled.map { $0["providerId"].text })
    }
    var menuBarSegments: [MenuBarSegment] {
        menuBarIDs.map { id in MenuBarSegment(providerID: id, name: name(id), provider: usage?.providers.first { $0.id == id }, now: now) }
    }
    func measureDetails(_ value: CGFloat) {
        guard value.isFinite, value > 0, abs((detailsHeight ?? 0) - value) > 0.5 else { return }
        detailsHeight = value; changed?()
    }
    func measureChrome(_ value: CGFloat) {
        guard value.isFinite, value > 0, abs((chromeHeight ?? 0) - value) > 0.5 else { return }
        chromeHeight = value; changed?()
    }
    func start() {
        reload()
        clock = Timer(timeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in self?.now = Date(); self?.changed?() } }
        if let clock { RunLoop.main.add(clock, forMode: .common) }
        wake = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.refresh(reason: "wake") } }
    }
    private func schedule() {
        timer?.invalidate()
        let interval = config["runtime"]["refreshIntervalSeconds"].number ?? 300
        timer = Timer(timeInterval: max(60, interval), repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh(reason: "timer") } }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    private func locate(cancellation: Cancellation) async throws -> NodeBridge {
        let explicit = config["runtime"]["nodePath"].string
        let bootstrap = UserDefaults.standard.string(forKey: "bootstrapNodePath")
        let root: URL
        if Bundle.main.bundleURL.pathExtension == "app", let resources = Bundle.main.resourceURL { root = resources }
        else { root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SUBSBAR_PROJECT_DIR"] ?? FileManager.default.currentDirectoryPath) }
        let configPath = ProcessInfo.processInfo.environment["SUBSBAR_CONFIG"]
        return try await Task.detached {
            let node: URL
            do { node = try NodeLocator.locate(explicit: bootstrap ?? (explicit == "auto" ? nil : explicit), cancellation: cancellation) }
            catch { throw LocalFailure("node-unavailable") }
            return NodeBridge(node: node, root: root, configPath: configPath)
        }.value
    }
    func reload() {
        guard !loading, !stopping else { return }
        loading = true
        let operation = UUID(), token = Cancellation(); activeCalls[operation] = token
        Task {
            defer { loading = false; finished(operation) }
            do {
                let bridge = try await locate(cancellation: token); self.bridge = bridge
                let result = try await Task.detached { () throws -> (ConfigDocument, Wire, UsageV1) in
                    let read = try bridge.call(["config", "read", "--json"], cancellation: token)
                    if let code = read.errorCode { throw LocalFailure(code) }
                    let doc = try ConfigDocument(read.value)
                    let registry = try bridge.call(["registry", "--json"], cancellation: token)
                    if let code = registry.errorCode { throw LocalFailure(code) }
                    guard registry.value["kind"].text == "registry" else { throw LocalFailure("schema-unsupported") }
                    let usage = try bridge.call(["usage", "--json"], cancellation: token)
                    if let code = usage.errorCode { throw LocalFailure(code) }
                    return (doc, registry.value, try UsageV1(usage.value))
                }.value
                guard !stopping else { return }
                // Replace the entire context. Never merge provider-only snapshots across identities.
                generation += 1; cancellation.cancel()
                document = result.0; registry = result.1; usage = result.2
                globalError = nil; now = Date(); schedule(); changed?()
                if let id = pendingConnect { pendingConnect = nil; refresh(provider: id, connect: true) }
                if let bootstrap = UserDefaults.standard.string(forKey: "bootstrapNodePath") {
                    save(base: result.0, patch: .object(["runtime": .object(["nodePath": .string(bootstrap)])])) { success in
                        if success { UserDefaults.standard.removeObject(forKey: "bootstrapNodePath") }
                    }
                } else if !startedRefresh {
                    startedRefresh = true
                    refresh(reason: "startup")
                }
            } catch { globalError = safeFailure(error); changed?() }
        }
    }
    private func safeFailure(_ error: Error) -> String {
        let code = String(describing: error)
        if ["core-unavailable", "node-unavailable"].contains(code) { return "无法连接数据引擎：请在设置中选择 Node，或重新安装完整应用" }
        return Presentation.error(code)
    }
    func bootstrap(_ path: String) {
        let operation = UUID(), token = Cancellation(); activeCalls[operation] = token
        Task {
            defer { finished(operation) }
            do {
                _ = try await Task.detached { try NodeLocator.locate(explicit: path, cancellation: token) }.value
                guard !stopping else { return }
                UserDefaults.standard.set(path, forKey: "bootstrapNodePath"); reload()
            } catch { globalError = "Node 不可用：请选择可执行的 Node 程序" }
        }
    }
    func save(base: ConfigDocument, patch: Wire, completion: @escaping @MainActor (Bool) -> Void = { _ in }) {
        guard !saving, !stopping, let bridge else { completion(false); return }
        saving = true
        let operation = UUID(), token = Cancellation(); activeCalls[operation] = token
        Task {
            defer { finished(operation) }
            do {
                let response = try await Task.detached { try bridge.call(["config", "set", "--stdin"], input: base.submission(patch: patch), cancellation: token) }.value
                guard !stopping else { saving = false; return }
                if let code = response.errorCode { throw LocalFailure(code) }
                guard response.value["kind"].text == "config-write" else { throw LocalFailure("schema-unsupported") }
                generation += 1; cancellation.cancel()
                // A successful write may invalidate an identity. Do not show any old-scope result.
                if !response.value["invalidatedProviderIds"].array.isEmpty { usage = nil }
                saving = false; globalError = nil; completion(true); reload()
            } catch {
                saving = false; globalError = safeFailure(error); completion(false)
                // Keep the editor draft. Reload is explicit; never retry a conflicting CAS automatically.
            }
        }
    }
    func patchUI(_ patch: Wire) { guard let document else { return }; save(base: document, patch: .object(["ui": patch])) }
    func choose(_ id: String) { patchUI(.object(["selectedProvider": id.isEmpty ? .null : .string(id)])) }
    func setVisible(_ value: Bool) {
        countdown?.invalidate(); countdown = nil
        if value {
            now = Date(); changed?()
            countdown = Timer(timeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in self?.now = Date() } }
            if let countdown { RunLoop.main.add(countdown, forMode: .common) }
        }
    }
    func refresh(reason: String = "manual", provider: String? = nil, connect: Bool = false) {
        guard !refreshing, !stopping, !saving, let bridge, document != nil else { return }
        guard !enabled.isEmpty else { receipt = "没有已启用的订阅"; return }
        if connect && provider == nil { return }
        refreshing = true; let token = Cancellation(); cancellation = token; let version = generation
        let operation = UUID(); activeCalls[operation] = token
        var args = ["refresh", "--json", "--reason", reason, "--interaction", connect ? "user-connect" : "background"]
        if let provider { args += ["--provider", provider] }
        let arguments = args
        Task {
            defer {
                refreshing = false
                finished(operation)
                changed?()
            }
            do {
                let response = try await Task.detached { try bridge.call(arguments, cancellation: token) }.value
                guard version == generation, !stopping else { return }
                if let code = response.errorCode { throw LocalFailure(code) }
                let snapshot = try UsageV1(response.value)
                guard usage == nil || usage?.context == snapshot.context else { throw LocalFailure("invalid-response") }
                usage = snapshot; receipt = snapshot.receiptText; now = Date()
            } catch {
                guard !stopping, version == generation else { return }
                receipt = token.cancelled ? "刷新已取消" : safeFailure(error)
                // A killed/crashed child is not evidence that any provider failed.
                let recovery = Cancellation(); activeCalls[operation] = recovery
                if let response = try? await Task.detached(operation: { try bridge.call(["usage", "--json"], cancellation: recovery) }).value,
                   let cached = try? UsageV1(response.value), version == generation, !stopping,
                   usage == nil || usage?.context == cached.context { usage = cached }
            }
        }
    }
    func cancelRefresh() { cancellation.cancel() }
    private func finished(_ id: UUID) {
        activeCalls.removeValue(forKey: id)
        if stopping && activeCalls.isEmpty { NSApp.reply(toApplicationShouldTerminate: true) }
    }
    func stop() -> Bool {
        stopping = true; timer?.invalidate(); clock?.invalidate(); countdown?.invalidate(); cancellation.cancel()
        activeCalls.values.forEach { $0.cancel() }
        if let wake { NSWorkspace.shared.notificationCenter.removeObserver(wake) }
        return !activeCalls.isEmpty
    }
}
