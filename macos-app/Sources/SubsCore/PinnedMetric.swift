import Foundation

public struct PinnedMetric: Sendable {
    public static let limit = 2
    public let text: String
    public let fraction: Double?
    public let style: String
    public init(pin: Wire, usage: UsageV1?, enabled: Bool, now: Date) {
        style = pin["style"].text
        guard enabled, let provider = usage?.providers.first(where: { $0.id == pin["providerId"].text && $0.profile == pin["profileId"].text }),
              !provider.invalid, !["disabled", "unsupported"].contains(provider.status),
              ["fresh", "stale"].contains(provider.freshness(at: now)), provider.raw["dataDisposition"].text != "legacy",
              let metric = (provider.windows + provider.metrics).first(where: { $0.id == pin["metricId"].text }), metric.valid else {
            text = "—"; fraction = nil; return
        }
        let value: Double?
        switch pin["field"].text {
        case "remaining-percent": value = metric.usedPercent.map { max(0, 100 - $0) }
        case "used-percent": value = metric.usedPercent
        case "remaining": value = metric.remaining
        case "used": value = metric.used
        case "value": value = metric.raw["value"].number
        default: value = nil
        }
        let isPercent = pin["field"].text.hasSuffix("-percent")
        text = value.map { Presentation.amount($0, currency: isPercent ? nil : metric.currency) + (isPercent ? "%" : "") } ?? "—"
        fraction = isPercent ? value.map { min(1, max(0, $0 / 100)) } : nil
    }
}
