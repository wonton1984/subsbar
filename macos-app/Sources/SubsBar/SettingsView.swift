import SwiftUI
import AppKit
import SubsCore

struct SettingsView: View {
    @ObservedObject var model: AppModel
    let initialProvider: String?
    @State private var providerID = ""
    @State private var editorVersion = UUID()
    @State private var settingsTab = 0
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("连接与设置").font(.title2.bold())
                Spacer()
                Button("重新载入") { model.reload(); editorVersion = UUID() }
                Button("选择 Node…") {
                    let panel = NSOpenPanel(); panel.canChooseDirectories = false
                    if panel.runModal() == .OK, let path = panel.url?.path { model.bootstrap(path) }
                }
            }
            if let error = model.globalError { Text(error).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            if model.loading { ProgressView("读取连接设置…") }
            HStack {
                Button("订阅连接") { settingsTab = 0 }.buttonStyle(.bordered).tint(settingsTab == 0 ? .accentColor : .secondary)
                Button("显示与刷新") { settingsTab = 1 }.buttonStyle(.bordered).tint(settingsTab == 1 ? .accentColor : .secondary)
            }
            if settingsTab == 0 {
                HSplitView {
                    List(selection: $providerID) {
                        ForEach(Array(model.providers.enumerated()), id: \.offset) { _, row in
                            VStack(alignment: .leading) {
                                Text(model.name(row["providerId"].text))
                                Text(row["supported"].bool ? (model.config["providers"][row["providerId"].text]["enabled"].bool ? "已添加" : "未添加") : "尚不支持")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.tag(row["providerId"].text)
                        }
                    }.frame(minWidth: 130, idealWidth: 150, maxWidth: 200)
                    if let document = model.document, let manifest = model.providers.first(where: { $0["providerId"].text == providerID }) {
                        ConnectionEditor(model: model, base: document, manifest: manifest)
                            .id(providerID + editorVersion.uuidString + document.contentToken)
                            .frame(minWidth: 350)
                    } else { Text("选择一个订阅开始连接。").padding() }
                }
            } else if let document = model.document {
                PreferencesEditor(model: model, base: document).id(editorVersion.uuidString + document.contentToken)
            }
        }.padding(16).frame(minWidth: 650, minHeight: 540)
            .onAppear { providerID = initialProvider ?? model.providers.first?["providerId"].text ?? "" }
            .onChange(of: model.loading) { loading in if !loading && providerID.isEmpty { providerID = initialProvider ?? model.providers.first?["providerId"].text ?? "" } }
    }
}

struct ConnectionEditor: View {
    @ObservedObject var model: AppModel
    let base: ConfigDocument
    let manifest: Wire
    @State private var draft: Wire
    @State private var profileIndex = 0
    @State private var readerID = ""
    @State private var saved = false
    @State private var copied = false
    @State private var keyText = ""
    @State private var advancedOpen = false
    init(model: AppModel, base: ConfigDocument, manifest: Wire) {
        self.model = model; self.base = base; self.manifest = manifest
        let existing = base.config["providers"][manifest["providerId"].text]
        _profileIndex = State(initialValue: existing["profiles"].array.firstIndex { $0["id"].text == existing["activeProfile"].text } ?? 0)
        _draft = State(initialValue: existing.isObject ? existing : .object(["enabled": .bool(false), "dataSource": .string("auto"), "allowCommunityEndpoints": .bool(false), "profiles": .array([])]))
    }
    var providerID: String { manifest["providerId"].text }
    var profiles: [Wire] { draft["profiles"].array }
    var profile: Wire { profiles.indices.contains(profileIndex) ? profiles[profileIndex] : .null }
    var readers: [Wire] { manifest["credentialReaders"].array }
    func field(_ key: String, inProfile: Bool = false) -> Binding<String> {
        Binding(get: { (inProfile ? profile : draft)[key].text }, set: { value in
            if inProfile { editProfile(key, .string(value)) } else { draft = draft.setting(key, .string(value)) }
        })
    }
    func flag(_ key: String, inProfile: Bool = false) -> Binding<Bool> {
        Binding(get: { (inProfile ? profile : draft)[key].bool }, set: { value in
            if inProfile { editProfile(key, .bool(value)) } else { draft = draft.setting(key, .bool(value)) }
        })
    }
    func editProfile(_ key: String, _ value: Wire) {
        guard profiles.indices.contains(profileIndex) else { return }
        var next = profiles; next[profileIndex] = profile.setting(key, value); draft = draft.setting("profiles", .array(next))
    }
    func addProfile() {
        let id = "profile-" + String(UUID().uuidString.lowercased().prefix(8))
        let next = Wire.object(["id": .string(id), "label": .string("新连接"), "discovery": .string("auto"), "allowKeychain": .bool(false), "allowBrowser": .bool(false), "allowLocalApi": .bool(false), "sources": .array([])])
        draft = draft.setting("profiles", .array(profiles + [next]))
        profileIndex = profiles.count - 1
        if draft["activeProfile"].text.isEmpty { draft = draft.setting("activeProfile", .string(id)) }
    }
    var guide: ConnectionGuide { ConnectionGuide(manifest: manifest, name: model.name(providerID)) }
    var card: CardModel { model.card(providerID, single: false) }
    var connectionIssue: String? { ProviderConnectionPresentation.unavailable(manifest: manifest, draft: draft) ?? (providerID == "zai" && profile["region"].text.isEmpty ? "请选择密钥所属地区后再连接。" : nil) }
    var connected: Bool { card.enabled && card.hasReport && !card.needsRepair }
    var guideOpen: Bool { model.guideOpen.contains(providerID) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(model.name(providerID)).font(.title3.bold())
                    Spacer()
                    if guide.kind != .unsupported {
                        Label(connected ? "已连接" : card.enabled && card.needsRepair ? "需要重新登录" : "未连接",
                              systemImage: connected ? "checkmark.circle.fill" : "circle.dashed")
                            .foregroundStyle(connected ? Palette.band(.green) : card.needsRepair ? Palette.band(.orange) : .secondary)
                    }
                }
                if let note = ProviderConnectionPresentation.note(providerID) {
                    Text(note).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if providerID == "zai" {
                    Picker("密钥地区（必选）", selection: Binding(get: { profile["region"].text }, set: { value in
                        if profiles.isEmpty { addProfile() }
                        editProfile("region", .string(value))
                    })) {
                        Text("请选择").tag("")
                        Text("Global").tag("global")
                        Text("CN（未实测）").tag("cn")
                    }
                }
                if let issue = connectionIssue { Text(issue).font(.caption).foregroundStyle(.orange) }
                primaryAction
                DisclosureGroup("高级", isExpanded: $advancedOpen) {
                    advanced.padding(.top, 8)
                }
            }.padding(12)
        }
        .onAppear { model.keyError = nil }
        .onDisappear { keyText = "" }
        .onChange(of: profileIndex) { _ in keyText = ""; model.keyError = nil }
        .onChange(of: guideOpen) { open in if !open { keyText = "" }; model.keyError = nil }
    }
    @ViewBuilder var primaryAction: some View {
        if guide.kind == .unsupported {
            Text(guide.instruction).foregroundStyle(.secondary)
        } else {
            if connected {
                VStack(alignment: .leading, spacing: 3) {
                    if let sentence = ConnectionGuide.sourceSentence(manifest: manifest, name: model.name(providerID)) { Text(sentence) }
                    if let updated = card.updated { Text(updated).foregroundStyle(.secondary) }
                }
            }
            HStack {
                if connected {
                    Button(guide.kind == .apiKey ? "更换 API Key" : "重新登录") { model.toggleGuide(providerID) }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                    Button("重新检测") { detect() }.disabled(connectionIssue != nil || model.saving || model.refreshing)
                } else if guide.prefersDetect {
                    Button(guide.primaryTitle) { detect() }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .disabled(connectionIssue != nil || model.saving || model.refreshing || model.keySaving)
                    Button(guide.kind == .apiKey ? "粘贴 API Key" : "其他登录方式") { model.toggleGuide(providerID) }
                } else {
                    Button(guide.primaryTitle) { model.toggleGuide(providerID) }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                }
            }
            if guideOpen {
                VStack(alignment: .leading, spacing: 10) {
                    Text(guide.instruction).fixedSize(horizontal: false, vertical: true)
                    if guide.unverified { Label("未验证", systemImage: "questionmark.circle").font(.caption).foregroundStyle(.secondary) }
                    if let link = guide.url.flatMap(URL.init(string:)) { Link("打开官方页面", destination: link) }
                    if guide.canPasteKey {
                        HStack {
                            SecureField("API Key", text: $keyText).textFieldStyle(.roundedBorder).frame(maxWidth: 320)
                            Button("保存并检测连接") {
                                let pasted = keyText; keyText = ""
                                let selected = profile["id"].string ?? "profile-" + String(UUID().uuidString.lowercased().prefix(8))
                                model.saveKey(guide: guide, base: base, draft: draft, profileID: selected, key: pasted)
                            }.disabled(connectionIssue != nil || keyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.saving || model.refreshing || model.keySaving)
                        }
                        Text("保存后，此账户将仅使用新密钥检测连接。").font(.caption).foregroundStyle(.secondary)
                        if let error = model.keyError { Text(error).font(.caption).foregroundStyle(Palette.band(.orange)) }
                    }
                    if let command = guide.command {
                        HStack {
                            Text(command).font(.system(.body, design: .monospaced)).padding(.horizontal, 8).padding(.vertical, 4)
                                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
                            Button(copied ? "已复制" : "复制命令") {
                                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(command, forType: .string); copied = true
                            }
                        }
                    }
                    HStack {
                        if !guide.canPasteKey || guide.command != nil { Button(guide.canPasteKey ? "我已登录，检测连接" : "我已完成，检测连接") { detect() }.disabled(connectionIssue != nil || model.saving || model.refreshing) }
                        if model.saving || model.refreshing || model.keySaving { ProgressView().controlSize(.small) }
                    }
                }.padding(10).background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
            }
            if !connected, card.enabled, let issue = card.issue {
                VStack(alignment: .leading, spacing: 2) {
                    Text(issue)
                    if let action = card.action { Text(action).foregroundStyle(.secondary) }
                }.foregroundStyle(Palette.band(.orange))
            }
        }
    }
    func detect() { guard connectionIssue == nil else { return }; model.connect(provider: providerID, base: base, draft: draft) }
    @ViewBuilder var advanced: some View {
            VStack(alignment: .leading, spacing: 12) {
                Text("默认会自动发现登录信息。只有连接不上时才需要在这里手动指定。").font(.caption).foregroundStyle(.secondary)
                Toggle("启用此订阅（失败时仍保留卡片）", isOn: flag("enabled"))
                Picker("用量来源", selection: field("dataSource")) {
                    Text("自动选择已准入来源").tag("auto")
                    ForEach(Array(manifest["dataSources"].array.enumerated()), id: \.offset) { _, source in
                        Text(Presentation.text(source["id"].text) + " · " + source["admission"].text).tag(source["id"].text)
                    }
                }
                Toggle("允许社区接口（仍须通过来源准入）", isOn: flag("allowCommunityEndpoints"))
                HStack {
                    Text("账户配置").fontWeight(.semibold)
                    Spacer()
                    Button("新增") { addProfile() }
                    if !profiles.isEmpty {
                        Button("删除") {
                            let removedID = profile["id"].text
                            var next = profiles; next.remove(at: profileIndex); draft = draft.setting("profiles", .array(next)); profileIndex = 0
                            if draft["activeProfile"].text == removedID { draft = draft.setting("activeProfile", next.first?["id"] ?? .null) }
                        }
                    }
                }
                if !profiles.isEmpty {
                    Picker("编辑配置", selection: $profileIndex) {
                        ForEach(Array(profiles.enumerated()), id: \.offset) { index, row in Text(Presentation.text(row["label"].string ?? row["id"].text)).tag(index) }
                    }
                    Picker("当前使用", selection: field("activeProfile")) {
                        ForEach(Array(profiles.enumerated()), id: \.offset) { _, row in Text(Presentation.text(row["label"].string ?? row["id"].text)).tag(row["id"].text) }
                    }
                    TextField("名称", text: field("label", inProfile: true))
                    if providerID != "zai" { TextField("地区（如适用）", text: field("region", inProfile: true)) }
                    TextField("组织 ID（如适用）", text: field("organizationId", inProfile: true))
                    Picker("来源发现", selection: field("discovery", inProfile: true)) {
                        Text("自动发现（仅当来源列表为空）").tag("auto")
                        Text("仅指定来源").tag("only")
                    }
                    Toggle("允许钥匙串访问", isOn: flag("allowKeychain", inProfile: true))
                    Toggle("允许浏览器来源", isOn: flag("allowBrowser", inProfile: true))
                    Toggle("允许本地 API", isOn: flag("allowLocalApi", inProfile: true))
                    Text("指定来源按下列顺序尝试，并完全替代自动发现；失效或过期会停止并提示修复。").font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(profile["sources"].array.enumerated()), id: \.offset) { index, source in
                        SourceEditor(source: source, declaration: readers.first { $0["id"].text == source["reader"].text } ?? .null,
                            change: { value in var sources = profile["sources"].array; sources[index] = value; editProfile("sources", .array(sources)) },
                            remove: { var sources = profile["sources"].array; sources.remove(at: index); editProfile("sources", .array(sources)) },
                            moveUp: index == 0 ? nil : { var sources = profile["sources"].array; sources.swapAt(index, index - 1); editProfile("sources", .array(sources)) })
                    }
                    Picker("可选凭证来源", selection: $readerID) {
                        Text("选择来源").tag("")
                        ForEach(Array(readers.enumerated()), id: \.offset) { _, reader in
                            Text(Presentation.text(reader["id"].text) + " · " + reader["kind"].text + (reader["implemented"].bool ? "" : "（尚不支持）")).tag(reader["id"].text)
                        }
                    }
                    Button("添加所选来源") {
                        guard let reader = readers.first(where: { $0["id"].text == readerID }) else { return }
                        let source = Wire.object(["id": .string("source-" + String(UUID().uuidString.lowercased().prefix(8))), "kind": reader["kind"], "reader": reader["id"], "purpose": reader["purposes"].array.first ?? .string("primary")])
                        editProfile("sources", .array(profile["sources"].array + [source]))
                    }.disabled(readerID.isEmpty)
                } else { Text("添加账户配置，然后选择此订阅支持的凭证来源。").foregroundStyle(.secondary) }
                Divider()
                Text("当前来源状态").fontWeight(.semibold)
                ForEach(Array(manifest["profiles"].array.enumerated()), id: \.offset) { _, current in
                    ForEach(Array(current["sources"].array.enumerated()), id: \.offset) { _, source in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(Presentation.text(source["reader"].text) + (source["originOfChoice"].text == "explicit" ? " · 指定来源" : " · 自动发现"))
                            Text(availability(source["availability"].text)).foregroundStyle(.secondary)
                            Text(expiry(source["credentialExpiry"])).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                if manifest["profiles"].array.isEmpty { Text("尚未配置来源 · 到期状态未知").foregroundStyle(.secondary) }
                if let issue = model.usage?.providers.first(where: { $0.id == providerID })?.issue { Text(issue).foregroundStyle(.orange) }
                HStack {
                    Button("保存配置") { save() }.disabled(model.saving || saved)
                    Button("连接 / 检查所选订阅") { detect() }
                        .disabled(connectionIssue != nil || model.saving || model.refreshing || !model.config["providers"][providerID]["enabled"].bool)
                }
                if saved { Text("已保存。重新载入设置后可继续编辑。").foregroundStyle(.secondary) }
                Text("先保存，再连接。连接只检查这一家；可能请求一次来源授权。此表单只保存来源引用，不接收或显示凭证。").font(.caption).foregroundStyle(.secondary)
            }.textFieldStyle(.roundedBorder)
    }
    func save() { model.save(base: base, patch: .object(["providers": .object([providerID: draft])])) { saved = $0 } }
    func availability(_ value: String) -> String {
        ["resolved": "已发现来源；连接后验证凭证", "missing": "未找到：检查来源位置，或在原应用登录", "invalid": "来源无效：修正引用或重新登录", "locked": "访问尚未确认：点击连接完成授权", "unsupported": "此来源尚未支持，请选择其他来源"][value] ?? "状态未知"
    }
    func expiry(_ value: Wire) -> String {
        if value["state"].text == "known", value["evidence"].text == "owner-metadata", let milliseconds = V1Metric.timestamp(value["expiresAtMs"]) {
            return "到期时间：" + Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .shortened)
        }
        return "到期状态未知"
    }
}

struct SourceEditor: View {
    let source: Wire
    let declaration: Wire
    let change: (Wire) -> Void
    let remove: () -> Void
    let moveUp: (() -> Void)?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(Presentation.text(source["reader"].text)).fontWeight(.medium)
                Spacer()
                if let moveUp { Button("上移", action: moveUp) }
                Button("移除", action: remove)
            }
            if !declaration["implemented"].bool { Text("尚不支持；保存不会使该来源获得执行权限").foregroundStyle(.orange) }
            Text("需要许可：" + (declaration["requires"].array.isEmpty ? "无额外许可" : declaration["requires"].array.map(\.text).joined(separator: "、"))).font(.caption)
            Picker("用途", selection: Binding(get: { source["purpose"].text }, set: { change(source.setting("purpose", .string($0))) })) {
                ForEach(declaration["purposes"].array.map(\.text), id: \.self) { purpose in Text(purpose == "management" ? "管理权限" : "主要用量").tag(purpose) }
            }
            ForEach(declaration["configurable"].array.map(\.text), id: \.self) { key in
                Text(fieldLabel(key)).font(.caption).foregroundStyle(.secondary)
                HStack {
                    TextField(fieldLabel(key), text: Binding(get: { source[key].text }, set: { value in
                        var fields = source.object
                        if value.isEmpty { fields.removeValue(forKey: key) } else { fields[key] = .string(value) }
                        change(.object(fields))
                    }))
                    if ["path", "executablePath"].contains(key) {
                        Button("选择…") {
                            let panel = NSOpenPanel(); panel.canChooseDirectories = false
                            if panel.runModal() == .OK, let path = panel.url?.path { change(source.setting(key, .string(path))) }
                        }
                    }
                }
            }
        }.padding(10).background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
    }
    func fieldLabel(_ key: String) -> String {
        ["envName": "环境变量名称（不是密钥）", "path": "文件位置（留空使用来源默认值）", "service": "钥匙串服务名", "account": "钥匙串项名称", "browserProfile": "浏览器配置名称", "origin": "已声明的站点来源", "executablePath": "程序路径（留空使用默认值）"][key] ?? key
    }
}

struct PreferencesEditor: View {
    @ObservedObject var model: AppModel
    let base: ConfigDocument
    @State private var ui: Wire
    @State private var runtime: Wire
    @State private var privacy: Wire
    @State private var compatibility: Wire
    @State private var saved = false
    init(model: AppModel, base: ConfigDocument) {
        self.model = model; self.base = base
        _ui = State(initialValue: base.config["ui"]); _runtime = State(initialValue: base.config["runtime"]); _privacy = State(initialValue: base.config["privacy"])
        _compatibility = State(initialValue: base.config["compatibility"])
    }
    func choice(_ key: String) -> Binding<String> { Binding(get: { ui[key].text }, set: { ui = ui.setting(key, .string($0)) }) }
    func flag(_ key: String) -> Binding<Bool> { Binding(get: { ui[key].bool }, set: { ui = ui.setting(key, .bool($0)) }) }
    var body: some View {
        VStack(spacing: 0) {
        ScrollView { Form {
            Picker("首页", selection: choice("overviewMode")) { Text("订阅卡片").tag("cards"); Text("单个订阅").tag("single") }
            Picker("外观", selection: choice("appearance")) { Text("跟随系统").tag("system"); Text("浅色").tag("light"); Text("深色").tag("dark") }
            Picker("密度", selection: choice("density")) { Text("紧凑").tag("compact"); Text("宽松").tag("comfortable") }
            Toggle("显示账户别名", isOn: flag("showAccountLabel"))
            Picker("默认仪表订阅", selection: Binding(get: { ui["selectedProvider"].text }, set: { ui = ui.setting("selectedProvider", $0.isEmpty ? .null : .string($0)) })) {
                Text("未选择").tag("")
                ForEach(Array(model.providers.enumerated()), id: \.offset) { _, row in Text(model.name(row["providerId"].text)).tag(row["providerId"].text) }
            }
            TextField("刷新间隔（秒）", text: Binding(get: { runtime["refreshIntervalSeconds"].number.map { String(Int($0)) } ?? "" }, set: { runtime = runtime.setting("refreshIntervalSeconds", Double($0).map(Wire.number) ?? .string($0)) }))
            TextField("请求超时（秒）", text: Binding(get: { runtime["timeoutSeconds"].number.map { String(Int($0)) } ?? "" }, set: { runtime = runtime.setting("timeoutSeconds", Double($0).map(Wire.number) ?? .string($0)) }))
            TextField("同时刷新数量", text: Binding(get: { runtime["maxConcurrency"].number.map { String(Int($0)) } ?? "" }, set: { runtime = runtime.setting("maxConcurrency", Double($0).map(Wire.number) ?? .string($0)) }))
            Toggle("允许发现浏览器来源", isOn: Binding(get: { privacy["allowBrowserDiscovery"].bool }, set: { privacy = privacy.setting("allowBrowserDiscovery", .bool($0)) }))
            Picker("诊断", selection: Binding(get: { privacy["diagnostics"].text }, set: { privacy = privacy.setting("diagnostics", .string($0)) })) {
                Text("关闭").tag("off"); Text("本地安全诊断").tag("local-redacted")
            }
            Toggle("允许 Pi 凭证兼容来源", isOn: Binding(get: { compatibility["pi"]["enabled"].bool }, set: { compatibility = compatibility.setting("pi", compatibility["pi"].setting("enabled", .bool($0))) }))
            HStack {
                Text("Pi 目录：" + (compatibility["pi"]["agentDir"].string ?? "默认位置"))
                Button("选择…") {
                    let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
                    if panel.runModal() == .OK, let path = panel.url?.path { compatibility = compatibility.setting("pi", compatibility["pi"].setting("agentDir", .string(path))) }
                }
            }
            Divider()
            MenuBarEditor(model: model, ui: $ui)
            Divider()
            LayoutEditor(model: model, ui: $ui)
        }.padding().disabled(saved || model.saving || model.loading) }
        Divider()
        HStack {
            Text(saved ? "已保存，正在载入…" : "修改后点击保存，菜单栏立即更新。")
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button("保存显示与刷新设置") {
                model.save(base: base, patch: .object(["ui": ui, "runtime": runtime, "privacy": privacy, "compatibility": compatibility])) { saved = $0 }
            }.disabled(model.saving || model.loading || saved)
        }.padding(10)
        }
    }
}

struct LayoutEditor: View {
    @ObservedObject var model: AppModel
    @Binding var ui: Wire
    var order: [String] {
        let declared = model.providers.map { $0["providerId"].text }
        let configured = ui["providerOrder"].array.map(\.text)
        return configured + declared.filter { !configured.contains($0) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("卡片顺序与内容").font(.headline)
            ForEach(Array(order.enumerated()), id: \.element) { index, id in
                DisclosureGroup(model.name(id)) {
                    HStack {
                        Button("上移") { var next = order; next.swapAt(index, index - 1); ui = ui.setting("providerOrder", .strings(next)) }.disabled(index == 0)
                        Toggle("默认展开", isOn: cardFlag(id, "expanded"))
                        Toggle("收藏", isOn: cardFlag(id, "favorite"))
                    }
                    if let provider = model.usage?.providers.first(where: { $0.id == id }) {
                        let metrics = orderedMetrics(provider)
                        ForEach(Array(metrics.enumerated()), id: \.element.id) { metricIndex, metric in
                            HStack {
                                Toggle(metric.label, isOn: Binding(get: { !ui["cards"][id]["hiddenMetricIds"].array.map(\.text).contains(metric.id) }, set: { visible in
                                    var hidden = ui["cards"][id]["hiddenMetricIds"].array.map(\.text).filter { $0 != metric.id }
                                    if !visible { hidden.append(metric.id) }
                                    setCard(id, "hiddenMetricIds", .strings(hidden))
                                }))
                                Spacer()
                                Button("上移") {
                                    var identifiers = metrics.map(\.id); identifiers.swapAt(metricIndex, metricIndex - 1)
                                    setCard(id, "metricOrder", .strings(identifiers))
                                }.disabled(metricIndex == 0)
                            }
                        }
                    }
                }
            }

        }
    }
    func orderedMetrics(_ provider: V1Provider) -> [V1Metric] {
        let order = ui["cards"][provider.id]["metricOrder"].array.map(\.text)
        return (provider.windows + provider.metrics).sorted { (order.firstIndex(of: $0.id) ?? 999) < (order.firstIndex(of: $1.id) ?? 999) }
    }
    func setCard(_ id: String, _ key: String, _ value: Wire) {
        ui = ui.setting("cards", ui["cards"].setting(id, ui["cards"][id].setting(key, value)))
    }
    func cardFlag(_ id: String, _ key: String) -> Binding<Bool> {
        Binding(get: { ui["cards"][id][key].bool }, set: { setCard(id, key, .bool($0)) })
    }
}

struct MenuBarEditor: View {
    @ObservedObject var model: AppModel
    @Binding var ui: Wire
    var ordered: [String] {
        let declared = model.providers.map { $0["providerId"].text }
        let configured = ui["providerOrder"].array.map(\.text)
        return configured.filter { declared.contains($0) } + declared.filter { !configured.contains($0) }
    }
    var selected: [String] { MenuBarSelection.selected(ui: ui, ordered: ordered, enabled: ordered.filter { model.config["providers"][$0]["enabled"].bool }) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("菜单栏显示").font(.headline)
            Text("每家一个圆环仪表：中心是名称缩写，外圈是剩余额度；顺序跟随下方订阅排序。未选择或上限为 0 时，仅保留一个无文字圆环入口。").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Picker("显示家数上限", selection: Binding(get: { Int(ui["menuBarLimit"].number ?? 1) }, set: { limit in
                ui = MenuBarEditing.limit(limit, ui: ui, ordered: ordered, enabled: ordered.filter { model.config["providers"][$0]["enabled"].bool })
            })) {
                ForEach(0..<5) { Text("\($0) 家").tag($0) }
            }
            ForEach(ordered, id: \.self) { id in
                Toggle(model.name(id) + (model.config["providers"][id]["enabled"].bool ? "" : "（未启用）"), isOn: Binding(get: { selected.contains(id) }, set: { on in
                    ui = MenuBarEditing.toggle(id, on: on, ui: ui, ordered: ordered, enabled: ordered.filter { model.config["providers"][$0]["enabled"].bool })
                })).disabled(!selected.contains(id) && selected.count >= 4)
            }
            Text("勾选会自动提高上限，最多 4 家；降低上限会保留顺序靠前的选择。保存后生效。").font(.caption).foregroundStyle(.secondary)
            Button("恢复默认：第一家已启用订阅") { ui = MenuBarEditing.defaults(ui) }
        }
    }
}
