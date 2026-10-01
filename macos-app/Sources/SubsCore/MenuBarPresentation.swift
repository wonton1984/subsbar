import Foundation

/// Provider-level menu bar values; uses normalized wire values without estimating missing quotas.
public struct MenuBarSegment: Equatable, Sendable {
    public let providerID: String
    public let name: String
    public let fraction: Double?
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
        fraction = metric.fraction
        if let fraction = metric.fraction { value = Cache.format(fraction * 100) + "%" }
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
        let candidates = ui["menuBarProviders"].isArray ? ui["menuBarProviders"].array.map(\.text) : Array(enabled.prefix(1))
        return ordered.filter { candidates.contains($0) }
    }
    public static func visible(ui: Wire, ordered: [String], enabled: [String]) -> [String] {
        Array(selected(ui: ui, ordered: ordered, enabled: enabled).prefix(min(4, Int(ui["menuBarLimit"].number ?? 1))))
    }
}
