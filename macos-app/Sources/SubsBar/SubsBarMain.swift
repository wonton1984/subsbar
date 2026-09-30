import AppKit
import SwiftUI
import SubsCore
import Darwin

@MainActor final class SingleInstanceGuard {
    private var fd: Int32 = -1
    func acquire() -> Bool {
        let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Caches/com.subsbar.native")
        do { try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true) } catch { return false }
        fd = open(path.appendingPathComponent("instance.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        return fd >= 0 && flock(fd, LOCK_EX | LOCK_NB) == 0
    }
    func release() { if fd >= 0 { flock(fd, LOCK_UN); close(fd); fd = -1 } }
}
@MainActor final class StatusController: NSObject, NSPopoverDelegate {
    let model: AppModel
    let item: NSStatusItem
    let popover = NSPopover()
    private var iconKey = ""
    private var local: Any?
    private var global: Any?
    private var appearance: NSKeyValueObservation?
    private var screenObserver: NSObjectProtocol?
    init(model: AppModel) {
        self.model = model
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        item.menu = nil
        item.button?.target = self; item.button?.action = #selector(toggle)
        item.button?.sendAction(on: .leftMouseUp)
        popover.behavior = .transient; popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: PopoverView(model: model))
        appearance = item.button?.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in Task { @MainActor in self?.update() } }
        screenObserver = NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.update() } }
        model.changed = { [weak self] in self?.update() }
        update()
    }
    func update() {
        guard let button = item.button else { return }
        let key = "\(model.fraction.map { String($0) } ?? "unknown")|\(button.effectiveAppearance.name.rawValue)|\(button.window?.backingScaleFactor ?? 2)"
        if key != iconKey {
            iconKey = key
            button.image = PieIconRenderer.draw(model.fraction, appearance: button.effectiveAppearance)
        }
        button.toolTip = model.tooltip; button.setAccessibilityLabel(model.tooltip)
        if popover.isShown { resize() }
    }
    private func resize() {
        let entry = model.entry
        let windows = (entry?.windows.count ?? 0) * 54
        let metrics = (entry?.metrics.count ?? 0) * 22
        let notes = (entry?.notes.count ?? 0) * 18
        let count = windows + metrics + notes
        let maxHeight = max(230, (item.button?.window?.screen?.visibleFrame.height ?? 700) - 40)
        let desiredHeight = ceil(model.detailsHeight ?? CGFloat(count)) + 146
        let height = min(maxHeight, max(230, desiredHeight))
        if abs(model.height - height) > 0.5 { model.height = height }
        popover.contentSize = NSSize(width: 350, height: model.height)
    }
    @objc func toggle() {
        if popover.isShown { popover.performClose(nil); return }
        guard let button = item.button, button.window != nil else { return }
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
                } else if event.window !== self.popover.contentViewController?.view.window && event.window !== self.item.button?.window {
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
        removeMonitors(); model.setVisible(false); item.button?.highlight(false)
        record("popover closed monitors=0 countdown=stopped")
    }
    func stop() {
        popover.performClose(nil); removeMonitors(); appearance?.invalidate()
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
        NSStatusBar.system.removeStatusItem(item)
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
        let delegate = AppDelegate(); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
