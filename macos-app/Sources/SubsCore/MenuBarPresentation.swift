import Foundation

/// Provider-level menu bar values; uses normalized wire values without estimating missing quotas.
public struct MenuBarSegment: Equatable, Sendable {
    public let providerID: String
    public let name: String
    public let fraction: Double?
    public private(set) var resetDescription: String? = nil
    public var title: String { fraction == nil && value != "…" ? value : "" }
    public func accessibilityTitle(fullName: String) -> String {
        Presentation.text(fullName) + " 剩余 " + (value == "…" ? "未知" : value) + (resetDescription.map { "（" + $0 + "）" } ?? "")
    }
    public let value: String
    public var text: String { name + " " + value }
    public init(providerID: String, name: String, provider: V1Provider?, now: Date) {
        self.providerID = providerID
        let safeName = Presentation.text(name)
        let initials = safeName.filter(\.isUppercase)
        self.name = initials.count >= 2 ? String(initials.prefix(3)) : String(safeName.prefix(3)).capitalized
        guard let provider, !provider.invalid, ["ok", "partial", "rate-limited"].contains(provider.status),
              provider.freshness(at: now) == "fresh", provider.raw["dataDisposition"].text == "current" else {
            fraction = nil; value = "…"; return
        }
        let declared = provider.report["primaryMetricId"].string
        let metric: V1Metric?
        if let declared, !declared.isEmpty {
            metric = (provider.windows + provider.metrics).first { $0.id == declared }
        } else {
            // A balance-only report has no quota primary. Never replace an unknown declared primary.
            metric = provider.metrics.first { $0.kind == "balance" }
        }
        guard let metric, metric.valid else { fraction = nil; value = "…"; return }
        resetDescription = metric.kind == "quota" ? MetricDisplay.shortReset(metric, now: now) : nil
        // Explicit remaining + limit is sufficient; never invent a denominator for balances.
        let ratio = metric.fraction ?? metric.remaining.flatMap { remaining in
            metric.limit.flatMap { $0 > 0 ? max(0, min(1, remaining / $0)) : nil }
        }
        fraction = ratio
        if let fraction = ratio { value = Cache.format(fraction * 100) + "%" }
        else if let remaining = metric.remaining { value = Self.amount(remaining, currency: metric.currency) }
        else if metric.kind == "balance", let amount = metric.raw["value"].number { value = Self.amount(amount, currency: metric.currency) }
        else { value = "…" }
    }
    private static func amount(_ value: Double, currency: String?) -> String {
        if currency == "USD" { return "$" + (value > 0 && value < 0.01 ? "<0.01" : String(format: "%.2f", value)) }
        return Presentation.amount(value, currency: currency)
    }
}

/// Selection projection only; config validation and legacy migration remain in Node.
public enum MenuBarSelection {
    public static func selected(ui: Wire, ordered: [String], enabled: [String]) -> [String] {
        let candidates = ui["menuBarProviders"].isArray ? ui["menuBarProviders"].array.map(\.text) : (ui["menuBarLimit"].number == 0 ? [] : Array(enabled.prefix(1)))
        return ordered.filter { candidates.contains($0) }
    }
    public static func visible(ui: Wire, ordered: [String], enabled: [String]) -> [String] {
        Array(selected(ui: ui, ordered: ordered, enabled: enabled).prefix(min(4, Int(ui["menuBarLimit"].number ?? 1))))
    }
}

/// Geometry used by the AppKit renderer. Clockwise from twelve o'clock.
public struct RingGauge: Equatable, Sendable {
    public let fraction: Double?
    public let hasKnownAmount: Bool
    public init(_ fraction: Double?, hasKnownAmount: Bool = false) {
        self.hasKnownAmount = hasKnownAmount
        self.fraction = fraction.flatMap { $0.isFinite ? max(0, min(1, $0)) : nil }
    }
    public var sweepDegrees: Double { (fraction ?? 0) * 360 }
    public var endDegrees: Double { 90 - sweepDegrees }
    public var dashed: Bool { fraction == nil && !hasKnownAmount }
    public var band: Band { Cache.band(fraction) }
}

/// User-intent edits only. Node remains the config validator and CAS writer.
public enum MenuBarEditing {
    public static func toggle(_ id: String, on: Bool, ui: Wire, ordered: [String], enabled: [String]) -> Wire {
        let current = MenuBarSelection.selected(ui: ui, ordered: ordered, enabled: enabled)
        guard ordered.contains(id), !on || current.contains(id) || current.count < 4 else { return ui }
        var next = current.filter { $0 != id }
        if on { next.append(id) }
        next = ordered.filter { next.contains($0) }
        return ui.setting("menuBarProviders", .strings(next))
            .setting("menuBarLimit", .number(Double(max(Int(ui["menuBarLimit"].number ?? 1), next.count))))
    }
    public static func limit(_ limit: Int, ui: Wire, ordered: [String], enabled: [String]) -> Wire {
        let retained = Array(MenuBarSelection.selected(ui: ui, ordered: ordered, enabled: enabled).prefix(limit))
        let result = ui.setting("menuBarLimit", .number(Double(limit)))
        return ui["menuBarProviders"].isArray || limit == 0 ? result.setting("menuBarProviders", .strings(retained)) : result
    }
    public static func defaults(_ ui: Wire) -> Wire { ui.setting("menuBarProviders", .null).setting("menuBarLimit", .number(1)) }
}

public enum ProviderNavigation {
    public static let chipWidth: Double = 78
    public static let spacing: Double = 5
    public static func visible(ui: Wire) -> Bool { ui["overviewMode"].text == "single" }
    public static func columns(width: Double) -> Int { max(1, Int((width + spacing) / (chipWidth + spacing))) }
    public static func rows<T>(_ items: [T], width: Double) -> [[T]] {
        let count = columns(width: width)
        return stride(from: 0, to: items.count, by: count).map { Array(items[$0..<min($0 + count, items.count)]) }
    }
    public static func selected(_ id: String, ui: Wire) -> Bool { ui["overviewMode"].text == "single" && ui["selectedProvider"].text == id }
    public static func focus(_ id: String) -> Wire { .object(["overviewMode": .string("single"), "selectedProvider": .string(id)]) }
}
