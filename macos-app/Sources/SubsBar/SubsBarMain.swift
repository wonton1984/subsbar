import AppKit
import SwiftUI
import SubsCore
import Darwin

@MainActor final class SingleInstanceGuard {
    private var fd: Int32 = -1
    func acquire() -> Bool {
        let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/com.subsbar.public-native")
        do { try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true) } catch { return false }
        fd = open(path.appendingPathComponent("instance.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        return fd >= 0 && flock(fd, LOCK_EX | LOCK_NB) == 0
    }
    func release() { if fd >= 0 { flock(fd, LOCK_UN); close(fd); fd = -1 } }
}
@MainActor final class StatusController: NSObject, NSPopoverDelegate {
    let model: AppModel
    private(set) var items: [NSStatusItem] = []
    private var anchorButton: NSStatusBarButton?
    private var stopped = false
    private var menuInputs: Wire = .null
    private var segments: [MenuBarSegment] = []
    let popover = NSPopover()
    private var settings: NSWindow?
    private var local: Any?
    private var global: Any?
    private var appearance: NSKeyValueObservation?
    private var screenObserver: NSObjectProtocol?
    init(model: AppModel) {
        self.model = model
        super.init()
        popover.behavior = .transient; popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: PopoverView(model: model))
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.update() } }
        model.changed = { [weak self] in self?.update() }
        model.openSettings = { [weak self] provider in self?.showSettings(provider) }
        update()
    }
    func showSettings(_ provider: String?) {
        if settings == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 640), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            window.title = "SubsBar 设置"; window.isReleasedWhenClosed = false; window.center(); settings = window
        }
        settings?.contentViewController = NSHostingController(rootView: SettingsView(model: model, initialProvider: provider))
        NSApp.activate(ignoringOtherApps: true); settings?.makeKeyAndOrderFront(nil)
    }
    func update() {
        guard !stopped else { return }
        let inputs = Wire.array([model.config, model.registry, model.usage?.raw ?? .null])
        if inputs != menuInputs {
            menuInputs = inputs
            segments = model.menuBarSegments
        }
        let count = max(1, segments.count)
        if items.count != count {
            popover.performClose(nil); anchorButton = nil
            appearance?.invalidate()
            for item in items { NSStatusBar.system.removeStatusItem(item) }
            items = (0..<count).map { _ in
                let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
                item.button?.target = self; item.button?.action = #selector(toggle(_:))
                item.button?.sendAction(on: .leftMouseUp)
                return item
            }
            appearance = items.first?.button?.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.update() } }
        }
        for (index, item) in items.enumerated() {
            guard let button = item.button else { continue }
            let segment = segments.indices.contains(index) ? segments[index] : nil
            button.image = PieIconRenderer.draw(segment?.fraction ?? (segments.isEmpty ? model.fraction : nil), appearance: button.effectiveAppearance)
            button.imagePosition = .imageLeading
            button.title = segment.map { " " + $0.text } ?? ""
            button.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize(for: .small), weight: .regular)
            button.toolTip = segment.map { model.name($0.providerID) + " · 剩余 " + $0.value } ?? model.tooltip
            button.setAccessibilityLabel(button.toolTip ?? "SubsBar")
        }
        let appearanceName = model.config["ui"]["appearance"].text
        let preferred: NSAppearance? = appearanceName == "dark" ? NSAppearance(named: .darkAqua) : appearanceName == "light" ? NSAppearance(named: .aqua) : nil
        popover.appearance = preferred; settings?.appearance = preferred
        if popover.isShown { resize() }
    }
    private func resize() {
        let maxHeight = max(230, ((anchorButton ?? items.first?.button)?.window?.screen?.visibleFrame.height ?? 700) - 40)
        let desiredHeight = ceil(model.detailsHeight ?? 250) + ceil(model.chromeHeight ?? PopoverLayout.fallbackChrome)
        let height = min(maxHeight, max(230, desiredHeight))
        if abs(model.height - height) > 0.5 { model.height = height }
        popover.contentSize = NSSize(width: PopoverLayout.width(for: model), height: model.height)
    }
    @objc func toggle(_ sender: Any? = nil) {
        if popover.isShown { popover.performClose(nil); return }
        guard let button = (sender as? NSStatusBarButton) ?? items.first?.button, button.window != nil else { return }
        anchorButton = button
        model.setVisible(true); resize()
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        installMonitors()
        record("popover opened monitors=2")
    }
    private func installMonitors() {
        removeMonitors()
        global = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            Task { @MainActor in self?.popover.performClose(nil) }
        }
        local = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]) { [weak self] event in
            let consume = MainActor.assumeIsolated {
                guard let self else { return false }
                if event.type == .keyDown {
                    if event.keyCode == 53 { self.popover.performClose(nil); return true }
                } else if event.window !== self.popover.contentViewController?.view.window && event.window !== self.anchorButton?.window {
                    self.popover.performClose(nil)
                }
                return false
            }
            return consume ? nil : event
        }
    }
    private func removeMonitors() {
        if let local { NSEvent.removeMonitor(local) }; if let global { NSEvent.removeMonitor(global) }
        local = nil; global = nil
    }
    func popoverShouldDetach(_ popover: NSPopover) -> Bool { false }
    func popoverWillClose(_ notification: Notification) {
        removeMonitors(); model.setVisible(false); items.forEach { $0.button?.highlight(false) }
        record("popover closed monitors=0 countdown=stopped")
    }
    func stop() {
        stopped = true
        popover.performClose(nil); removeMonitors(); appearance?.invalidate()
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        for item in items { NSStatusBar.system.removeStatusItem(item) }; items = []
    }
}
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    let instance = SingleInstanceGuard()
    var model: AppModel?
    var status: StatusController?
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard instance.acquire() else { record("duplicate instance rejected"); NSApp.terminate(nil); return }
        let model = AppModel(); self.model = model
        status = StatusController(model: model)
        model.start()
        // Development-only launch aid for UI automation that cannot bind a windowless app.
        if CommandLine.arguments.contains("--show-popover") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.status?.toggle() }
        }
        record("ready bundle=\(Bundle.main.bundleIdentifier ?? "bare") accessory=\(NSApp.activationPolicy() == .accessory)")
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if status?.popover.isShown == false { status?.toggle() }
        return false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        status?.stop()
        return model?.stop() == true ? .terminateLater : .terminateNow
    }
    func applicationWillTerminate(_ notification: Notification) { instance.release(); record("terminated cleanly") }
}
@main struct SubsBarMain {
    @MainActor static func main() {
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--verify-icons" {
            do { try PieIconRenderer.verify(at: URL(fileURLWithPath: CommandLine.arguments[2])) }
            catch { print("Icon verification failed"); exit(1) }
            return
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        if [4, 5].contains(CommandLine.arguments.count) && CommandLine.arguments[1] == "--render-synthetic" {
            do {
                try SyntheticRender.run(fixtures: URL(fileURLWithPath: CommandLine.arguments[2]), output: URL(fileURLWithPath: CommandLine.arguments[3]),
                                        registryOverride: CommandLine.arguments.count == 5 ? URL(fileURLWithPath: CommandLine.arguments[4]) : nil)
            } catch { print("Synthetic rendering failed: \(error)"); exit(1) }
            return
        }
        let delegate = AppDelegate(); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
