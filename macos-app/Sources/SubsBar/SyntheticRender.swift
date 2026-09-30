import AppKit
import SwiftUI
import SubsCore

@MainActor enum SyntheticRender {
    static func run(fixtures: URL, output: URL) throws {
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
        try render(PopoverView(model: model), size: NSSize(width: 350, height: 420), to: output.appendingPathComponent("M1-synthetic-remaining-only.png"))
        try render(SettingsView(model: model, initialProvider: "commandcode"), size: NSSize(width: 820, height: 900), to: output.appendingPathComponent("M1-synthetic-settings.png"))
        model.registry = try read("registry-empty-home.json")
        model.document = try ConfigDocument(read("config-read-synthetic.json").setting("config", model.config.setting("providers", .object([:]))))
        try render(SettingsView(model: model, initialProvider: "codex"), size: NSSize(width: 820, height: 760), to: output.appendingPathComponent("M1-synthetic-empty-home.png"))
        print("PASS: 3 synthetic SwiftUI renders; no refresh, config writes or credentials")
    }
    private static func render<Content: View>(_ content: Content, size: NSSize, to destination: URL) throws {
        let hosting = NSHostingView(rootView: content.background(Color(nsColor: .windowBackgroundColor)).environment(\.colorScheme, .light))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = hosting
        window.appearance = NSAppearance(named: .aqua)
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
