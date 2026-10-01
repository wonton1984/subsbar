import AppKit
import SwiftUI
import SubsCore

@MainActor enum SyntheticRender {
    static func run(fixtures: URL, output: URL, registryOverride: URL?) throws {
        func read(_ name: String) throws -> Wire { try Wire.parse(Data(contentsOf: fixtures.appendingPathComponent(name))) }
        let model = AppModel()
        model.document = try ConfigDocument(read("config-read-synthetic.json"))
        model.registry = try read("registry-synthetic.json")
        let normalized = try read("usage-golden-normalized.json")
        model.now = Date(timeIntervalSince1970: normalized["nowMs"].number! / 1000)
        let metric = normalized["vectors"]["remaining-only"]["output"]
        let report = Wire.object(["name": .string("合成余额场景"), "capturedAtMs": normalized["nowMs"], "observationBasis": .string("remote-response"), "primaryMetricId": metric["id"], "windows": .array([metric]), "metrics": .array([]), "diagnostics": .array([.object(["code": .string("summary-unavailable")])])])
        let row = Wire.object(["providerId": .string("commandcode"), "profileId": .string("personal"), "scopeKey": .string("scope-synthetic-a"), "status": .string("partial"), "source": .object(["dataSourceId": .string("commandcode-alpha")]), "lastSuccessAtMs": normalized["nowMs"], "dataDisposition": .string("current"), "report": report])
        model.usage = try UsageV1(.object(["schemaVersion": .number(1), "kind": .string("usage"), "contextId": .string("context-synthetic-default"), "cacheRevision": .number(1), "generatedAtMs": normalized["nowMs"], "providers": .array([row]), "diagnostics": .array([])]))
        model.height = 420
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try render(PopoverView(model: model), size: NSSize(width: PopoverLayout.width, height: 420), to: output.appendingPathComponent("M1-synthetic-remaining-only.png"))
        try render(SettingsView(model: model, initialProvider: "commandcode"), size: NSSize(width: 820, height: 900), to: output.appendingPathComponent("M1-synthetic-settings.png"))
        let settingsRegistry = model.registry, settingsDocument = model.document
        model.registry = try read("registry-empty-home.json")
        model.document = try ConfigDocument(read("config-read-synthetic.json").setting("config", model.config.setting("providers", .object([:]))))
        try render(SettingsView(model: model, initialProvider: "codex"), size: NSSize(width: 820, height: 760), to: output.appendingPathComponent("M1-synthetic-empty-home.png"))
        model.registry = settingsRegistry; model.document = settingsDocument

        // M2: 14-provider scene built from the golden file; registry names come from the real Node registry when supplied.
        let registry = try registryOverride.map { try Wire.parse(Data(contentsOf: $0)) } ?? syntheticRegistry(names: model.registry)
        let base = try read("config-read-synthetic.json")
        func scene(enabled: [String], ui: [String: Wire] = [:], decorated: Bool = true) throws {
            var config = SyntheticScenes.config(base["config"], enabled: enabled)
            for (key, value) in ui { config = config.setting("ui", config["ui"].setting(key, value)) }
            model.document = try ConfigDocument(base.setting("config", config))
            model.registry = registry
            model.usage = try SyntheticScenes.usage(normalized, decorated: decorated)
            model.expandedOverrides = [:]
            model.addSubscriptionExpanded = false
            model.receipt = "本次部分更新"
        }
        var outputs: [String] = []
        func popover(_ name: String, maxHeight: CGFloat = 900, dark: Bool = false) throws {
            try renderPopover(model, to: output.appendingPathComponent(name), maxHeight: maxHeight, dark: dark); outputs.append(name)
        }
        for count in [3, 4, 6, 14] {
            try scene(enabled: Array(SyntheticScenes.providerIDs.prefix(count)))
            try popover("M10-grid-\(count)-light.png", maxHeight: 1600)
            try popover("M10-grid-\(count)-dark.png", maxHeight: 1600, dark: true)
        }
        for state in ["ok", "unknown", "exceeded"] {
            for count in 0...4 {
                for dark in [false, true] {
                    let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
                    let names = ["Cod", "Kim", "OC", "CC"]
                    let fractions: [Double?] = state == "unknown" ? [nil, nil, nil, nil] : state == "exceeded" ? [0, 0, 0, 0] : [0.82, 0.5, 0.2, 0.07]
                    let strip = HStack(spacing: 8) {
                        ForEach(0..<max(1, count), id: \.self) { index in
                            Image(nsImage: RingIconRenderer.draw(fractions[index], name: count == 0 ? "" : names[index], appearance: appearance))
                        }
                    }.padding(.horizontal, 6)
                    let name = "M12-ring-\(state)-\(count)-\(dark ? "dark" : "light").png"
                    try render(strip, size: NSSize(width: max(1, count) * 28 + 4, height: 24), to: output.appendingPathComponent(name), dark: dark)
                    outputs.append(name)
                }
            }
        }
        for dark in [false, true] {
            let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
            let strip = HStack(spacing: 3) {
                Image(nsImage: RingIconRenderer.draw(nil, name: "Cur", hasKnownAmount: true, appearance: appearance))
                Text("$42.00").font(.system(size: 11)).monospacedDigit()
            }
            let name = "M12-ring-balance-\(dark ? "dark" : "light").png"
            try render(strip, size: NSSize(width: 76, height: 24), to: output.appendingPathComponent(name), dark: dark)
            outputs.append(name)
        }
        try scene(enabled: SyntheticScenes.enabledIDs, ui: ["menuBarProviders": .strings(["codex", "kimi", "commandcode"]), "menuBarLimit": .number(3)])
        for dark in [false, true] {
            let name = "M11-settings-\(dark ? "dark" : "light").png"
            try render(MenuBarEditor(model: model, ui: .constant(model.config["ui"])).padding(16).frame(width: 460, height: 550, alignment: .topLeading), size: NSSize(width: 460, height: 550), to: output.appendingPathComponent(name), dark: dark)
            outputs.append(name)
        }
        try scene(enabled: ["codex", "commandcode", "cursor", "claude"])
        try popover("M2-cards-default.png", maxHeight: 1200)
        try popover("M2-cards-default-dark.png", maxHeight: 1200, dark: true)
        model.addSubscriptionExpanded = true
        try popover("M2-cards-default-add-expanded.png", maxHeight: 1200)
        model.addSubscriptionExpanded = false
        try scene(enabled: SyntheticScenes.enabledIDs)
        try popover("M2-cards-all-scroll.png", maxHeight: 640)
        try popover("M2-cards-all-full.png", maxHeight: 4000)
        try scene(enabled: SyntheticScenes.enabledIDs, ui: ["menuBarProviders": .strings(["codex", "commandcode"]), "menuBarLimit": .number(2)])
        for id in SyntheticScenes.enabledIDs { model.expandedOverrides[id] = true }
        try popover("M2-cards-expanded-full.png", maxHeight: 6000)
        for id in ["codex", "commandcode", "claude", "devin"] {
            try scene(enabled: SyntheticScenes.enabledIDs, ui: ["overviewMode": .string("single"), "selectedProvider": .string(id)])
            try popover("M2-compact-\(id).png")
        }
        try scene(enabled: [])
        try popover("M2-cards-empty.png")

        // Connection flow: not connected -> guide -> connected, on the real Codex manifest declarations.
        let home = registryOverride != nil ? registry : try read("registry-empty-home.json")
        func connectShot(_ name: String, provider: String = "codex") throws {
            try render(SettingsView(model: model, initialProvider: provider), size: NSSize(width: 820, height: 560), to: output.appendingPathComponent(name)); outputs.append(name)
        }
        try scene(enabled: [])
        model.registry = home; model.usage = nil; model.receipt = nil
        model.guideOpen = []
        try connectShot("M3-connect-1-unconnected.png")
        model.guideOpen = ["codex"]
        try connectShot("M3-connect-2-guide.png")
        try scene(enabled: ["codex"])
        let resolved = Wire.object(["sources": .array([.object(["id": .string("auto-codex"), "kind": .string("cli"), "reader": .string("codex-official"), "purpose": .string("primary"), "originOfChoice": .string("auto"), "availability": .string("resolved")])])])
        model.registry = home.setting("providers", .array(home["providers"].array.map { $0["providerId"].text == "codex" ? $0.setting("profiles", .array([resolved])) : $0 }))
        model.guideOpen = []
        try connectShot("M3-connect-3-connected.png")
        try scene(enabled: [])
        model.registry = home; model.usage = nil; model.receipt = nil
        model.guideOpen = ["kimi", "commandcode"]
        try connectShot("M3-connect-4-apikey-paste.png", provider: "kimi")
        try connectShot("M3-connect-5-guide-only.png", provider: "commandcode")
        print("PASS: \(3 + outputs.count) synthetic SwiftUI renders; no refresh, config writes or credentials")
    }
    private static func syntheticRegistry(names: Wire) -> Wire {
        let known = Dictionary(names["providers"].array.map { ($0["providerId"].text, $0) }, uniquingKeysWith: { first, _ in first })
        return .object(["schemaVersion": .number(1), "kind": .string("registry"), "providers": .array(SyntheticScenes.providerIDs.map { id in
            known[id] ?? .object(["providerId": .string(id), "name": .string(id), "supported": .bool(false)])
        })])
    }
    /// Lays out at the maximum height, then re-renders at the measured content height like the live popover.
    private static func renderPopover(_ model: AppModel, to destination: URL, maxHeight: CGFloat, dark: Bool) throws {
        model.detailsHeight = nil; model.chromeHeight = nil
        model.height = maxHeight
        let view = PopoverView(model: model)
        try render(view, size: NSSize(width: PopoverLayout.width(for: model), height: maxHeight), to: destination, dark: dark)
        let natural = ceil(model.detailsHeight ?? 250) + ceil(model.chromeHeight ?? PopoverLayout.fallbackChrome)
        model.height = min(maxHeight, max(230, natural))
        try render(view, size: NSSize(width: PopoverLayout.width(for: model), height: model.height), to: destination, dark: dark)
    }
    private static func render<Content: View>(_ content: Content, size: NSSize, to destination: URL, dark: Bool = false) throws {
        let hosting = NSHostingView(rootView: content.background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, dark ? .dark : .light))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = hosting
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.setFrameOrigin(NSPoint(x: -10000, y: -10000)); window.orderFront(nil)
        hosting.frame = NSRect(origin: .zero, size: size)
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        hosting.layoutSubtreeIfNeeded(); hosting.display()
        guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { throw LocalFailure("render-failed") }
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw LocalFailure("render-failed") }
        try png.write(to: destination); window.close()
    }
}
