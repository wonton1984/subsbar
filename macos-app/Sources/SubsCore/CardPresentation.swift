import Foundation

/// Display projection shared by the cards overview and the compact single-provider view.
/// It only composes `V1Provider`/`V1Metric` semantics; it never normalizes provider data.
public struct MetricDisplay: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let kind: String
    public let valid: Bool
    public let isPrimary: Bool
    public let summary: String
    public let unitLabel: String
    public let usedPercent: Double?
    /// Remaining fraction for drawing; nil means unknown, never zero.
    public let fraction: Double?
    public let band: Band
    public let showsBar: Bool
    public let overage: String?
    public let inconsistent: Bool
    public let resetShort: String?
    public let resetFull: String?
    public init(_ metric: V1Metric, primaryID: String?, now: Date) {
        id = metric.id; label = metric.label; kind = metric.kind; valid = metric.valid
        isPrimary = primaryID != nil && metric.id == primaryID
        summary = metric.summary
        unitLabel = metric.valid ? ["tokens": "tokens", "requests": "次请求", "credits": "credits"][metric.unit] ?? "" : ""
        usedPercent = metric.usedPercent
        fraction = metric.fraction
        band = Cache.band(metric.fraction)
        showsBar = metric.valid && metric.kind == "quota"
        overage = (metric.usedPercent ?? 0) > 100 ? "超额 · 已用 \(Cache.format(metric.usedPercent!))%" : nil
        inconsistent = metric.inconsistent
        if metric.valid && metric.kind == "quota" {
            resetFull = metric.reset(at: now)
            resetShort = MetricDisplay.shortReset(metric, now: now)
        } else { resetFull = nil; resetShort = nil }
    }
    static func shortReset(_ metric: V1Metric, now: Date) -> String {
        if metric.raw["period"]["resetState"].text == "not-started" { return "窗口尚未激活" }
        guard metric.raw["period"]["resetState"].text == "known", let ms = V1Metric.timestamp(metric.raw["period"]["resetsAtMs"]) else { return "重置时间未知" }
        let delta = ms / 1000 - now.timeIntervalSince1970
        guard delta > 0 else { return "已到重置时间，等待更新" }
        let seconds = Int(min(delta, 253402300799))
        let days = seconds / 86400, hours = seconds % 86400 / 3600, minutes = seconds % 3600 / 60
        if days > 0 { return "\(days)天\(hours)时后重置" }
        if hours > 0 { return "\(hours)时\(minutes)分后重置" }
        return minutes > 0 ? "\(minutes)分后重置" : "1分钟内重置"
    }
}

public struct CardModel: Equatable, Sendable {
    public enum Tone: String, Sendable { case normal, warning, critical, muted }
    public let providerID: String
    public let name: String
    public let enabled: Bool
    public let hasEntry: Bool
    public let hasReport: Bool
    public let status: String
    public let statusText: String
    public let tone: Tone
    /// Menu-bar-equivalent value: gated by status, freshness and disposition exactly like the icon.
    public let headlineFraction: Double?
    public let headline: String
    public let issue: String?
    public let action: String?
    public let attempt: String?
    public let needsRepair: Bool
    public let freshness: String
    public let freshnessNote: String?
    public let updated: String?
    public let sampledAtMs: Double?
    public let source: String?
    public let accountLabel: String?
    public let favorite: Bool
    public let expanded: Bool
    public let primaryHidden: Bool
    /// Collapsed card rows: primary window plus one secondary window/balance.
    public let summaryMetrics: [MetricDisplay]
    /// Expanded card / compact view rows: every visible metric in user order.
    public let allMetrics: [MetricDisplay]
    public let diagnostics: [String]
    public let placeholder: String?
    public var metrics: [MetricDisplay] { expanded ? allMetrics : summaryMetrics }

    public init(providerID: String, name: String, config: Wire, usage: UsageV1?, now: Date, expanded: Bool) {
        let entry = usage?.providers.first { $0.id == providerID }
        let preferences = config["ui"]["cards"][providerID]
        self.providerID = providerID; self.name = name
        enabled = config["providers"][providerID]["enabled"].bool
        hasEntry = entry != nil
        favorite = preferences["favorite"].bool
        self.expanded = expanded
        let status = enabled ? entry?.status ?? "not-configured" : "disabled"
        self.status = status
        statusText = Presentation.status(status)
        let invalid = entry?.invalid ?? false
        if invalid { tone = .critical }
        else {
            switch status {
            case "ok": tone = .normal
            case "partial", "stale", "rate-limited": tone = .warning
            case "reauth-required", "permission-denied", "error", "unsupported": tone = .critical
            default: tone = .muted
            }
        }
        guard enabled, let entry else {
            headlineFraction = nil; headline = "未知"; issue = nil; action = nil; attempt = nil
            needsRepair = enabled; freshness = "none"; freshnessNote = nil; updated = nil; sampledAtMs = nil; source = nil
            accountLabel = nil; primaryHidden = false; summaryMetrics = []; allMetrics = []; diagnostics = []
            placeholder = enabled ? "暂无用量数据" : "未启用"
            hasReport = false
            return
        }
        headlineFraction = entry.iconFraction(at: now)
        headline = headlineFraction.map { Cache.format($0 * 100) + "%" } ?? "未知"
        issue = entry.issue
        action = entry.raw["error"]["action"].string != nil ? Presentation.action(entry.raw["error"]["action"].text) : nil
        attempt = entry.attemptMessage
        // Waiting actions (retry-later, update-client, contact-maintainer) are not fixable from connection settings.
        needsRepair = ["not-configured", "reauth-required", "permission-denied"].contains(status)
            || ["configure-source", "select-profile", "allow-source", "relogin-owner", "check-permission", "check-plan-region"].contains(entry.raw["error"]["action"].text)
        hasReport = entry.report.isObject
        guard entry.report.isObject else {
            freshness = "none"; freshnessNote = nil; updated = nil; sampledAtMs = nil; source = nil; accountLabel = nil
            primaryHidden = false; summaryMetrics = []; allMetrics = []; diagnostics = []
            placeholder = "暂无用量数据；连接状态保持可见"
            return
        }
        placeholder = nil
        let freshness = entry.freshness(at: now)
        self.freshness = freshness
        freshnessNote = freshness == "fresh" ? nil : freshness == "stale" ? "上次数据 · 已陈旧" : "历史或时间异常数据 · 比例不用于菜单栏"
        let stamp = V1Metric.timestamp(entry.report["observedAtMs"]) ?? V1Metric.timestamp(entry.report["capturedAtMs"])
        sampledAtMs = stamp
        updated = stamp.map { CardModel.relative(ms: $0, now: now) }
        source = entry.raw["source"]["dataSourceId"].string.map { Presentation.text($0) }
        accountLabel = config["ui"]["showAccountLabel"].bool
            ? config["providers"][providerID]["profiles"].array.first(where: { $0["id"].text == entry.profile })?["label"].string.map { Presentation.text($0) }
            : nil
        let hidden = preferences["hiddenMetricIds"].array.map(\.text)
        let order = preferences["metricOrder"].array.map(\.text)
        let visible = (entry.windows + entry.metrics).filter { !hidden.contains($0.id) }
            .sorted { (order.firstIndex(of: $0.id) ?? 999) < (order.firstIndex(of: $1.id) ?? 999) }
        let primaryID = entry.primary?.id
        let rows = visible.map { MetricDisplay($0, primaryID: primaryID, now: now) }
        allMetrics = rows
        primaryHidden = primaryID != nil && !rows.contains { $0.isPrimary }
        // The primary never gets replaced; the other slot shows the next visible window or balance under its own label.
        let lead = rows.first { $0.isPrimary }
        let rest = rows.filter { !$0.isPrimary }
        summaryMetrics = Array(((lead.map { [$0] } ?? []) + rest).prefix(2))
        diagnostics = entry.report["diagnostics"].array.map { Presentation.diagnostic($0["code"].text) }
    }

    public static func relative(ms: Double, now: Date) -> String {
        let age = now.timeIntervalSince1970 - ms / 1000
        if age < -300 { return "采样时间异常" }
        if age < 60 { return "刚刚更新" }
        if age < 3600 { return "\(Int(age / 60)) 分钟前更新" }
        if age < 86400 { return "\(Int(age / 3600)) 小时前更新" }
        return "\(Int(age / 86400)) 天前更新"
    }
}

/// Splits the registry into visible cards and the "add subscription" list.
/// Enabled providers stay in the card list whatever their status, so a failure never hides coverage.
public struct ProviderSections: Equatable, Sendable {
    public let cards: [String]
    public let available: [String]
    public init(registry: [Wire], config: Wire) {
        let order = config["ui"]["providerOrder"].array.map(\.text)
        let ids = registry.map { $0["providerId"].text }
            .sorted { (order.firstIndex(of: $0) ?? 999) < (order.firstIndex(of: $1) ?? 999) }
        cards = ids.filter { config["providers"][$0]["enabled"].bool }
        available = ids.filter { !config["providers"][$0]["enabled"].bool }
    }
}

/// Row-major layout preserves the configured provider ordering.
public struct OverviewLayout {
    public let columns: Int
    public var width: Double { columns == 2 ? 560 : 360 }
    public init(count: Int, single: Bool = false) { columns = !single && count > 3 ? 2 : 1 }
    public func rows(_ ids: [String]) -> [[String]] {
        stride(from: 0, to: ids.count, by: columns).map { Array(ids[$0..<min($0 + columns, ids.count)]) }
    }
}
public extension CardModel {
    func displayedMetrics(compact: Bool) -> [MetricDisplay] {
        compact && !expanded ? Array(metrics.prefix(1)) : metrics
    }
}
