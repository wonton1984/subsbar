import Foundation
import CoreFoundation

public struct Provider: Identifiable, Sendable {
    public let id: String, name: String
    public let supported: Bool
    public static let all = [Provider(id: "codex", name: "Codex", supported: true), Provider(id: "opencode", name: "OpenCode", supported: true), Provider(id: "kimi", name: "Kimi", supported: true), Provider(id: "commandcode", name: "CmdCode", supported: true), Provider(id: "droid", name: "droid", supported: true), Provider(id: "cursor", name: "Cursor", supported: true)]
}
public enum Band: String, Sendable { case green, orange, red, gray }
public enum Freshness: String, Sendable { case fresh = "正常缓存", stale = "过时缓存", expired = "历史缓存（已失效）", invalid = "缓存时间未知或时钟异常" }
public struct UsageWindow: Identifiable, Sendable, Equatable {
    public let id: String, label: String, unit: String
    public let used: Double?, remaining: Double?, limit: Double?, resetsAt: Date?
    public let primary: Bool
    public var effectiveUsed: Double? {
        if let used { return used }
        if let remaining, let limit, limit > 0, remaining <= limit { return limit - remaining }
        return nil
    }
    public var usedPercent: Double? {
        guard let used = effectiveUsed else { return nil }
        if unit == "percent", self.used != nil { return used }
        guard let limit, limit > 0 else { return nil }
        return used / limit * 100
    }
    public var fraction: Double? { usedPercent.map { max(0, min(1, (100 - $0) / 100)) } }
    public var inconsistent: Bool {
        guard let used, let remaining, let limit else { return false }
        return abs(used + remaining - limit) > max(0.001, limit * 0.001)
    }
}
public struct Metric: Identifiable, Sendable, Equatable { public let id: Int; public let label: String, value: String }
public struct Entry: Sendable, Equatable {
    public let name: String, windows: [UsageWindow], metrics: [Metric], notes: [String]
    public let fetchedAt: Date?, capturedAt: Date?, error: String?, warnings: [String]
    public var main: UsageWindow? { windows.first(where: { $0.primary }) ?? windows.first(where: { $0.used != nil }) ?? windows.first }
    public var fraction: Double? { main?.fraction }
    public var valid: Bool { error == nil }
    public func freshness(at now: Date) -> Freshness {
        guard let fetchedAt, fetchedAt <= now.addingTimeInterval(300) else { return .invalid }
        let age = now.timeIntervalSince(fetchedAt)
        return age >= 86400 ? .expired : age > 600 ? .stale : .fresh
    }
    public func iconFraction(at now: Date) -> Double? {
        guard valid, [.fresh, .stale].contains(freshness(at: now)) else { return nil }
        return fraction
    }
}
public struct LocalFailure: Error, Sendable, CustomStringConvertible {
    public let description: String
    public init(_ text: String) { description = text }
}
public enum Cache {
    public static let maxBytes = 1_048_576
    public static func safe(_ input: String) -> String {
        let text = String(input.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.prefix(512))
        return text.replacingOccurrences(of: "(?i)(bearer\\s+\\S+|(?:sk-|sk_|eyJ)[A-Za-z0-9_.-]+|(?:token|api[_ -]?key|authorization)\\s*[:=]\\s*\\S+)", with: "[已隐藏凭证]", options: .regularExpression)
    }
    public static func number(_ raw: Any?) -> Double? {
        let n: Double?
        if let value = raw as? NSNumber { n = CFGetTypeID(value) == CFBooleanGetTypeID() ? nil : value.doubleValue }
        else if let value = raw as? String, value.range(of: "^[+]?[0-9]+(?:\\.[0-9]+)?$", options: .regularExpression) != nil { n = Double(value) }
        else { n = nil }
        guard let n, n.isFinite, n >= 0 else { return nil }; return n
    }
    static func date(_ raw: Any?, divisor: Double) -> Date? {
        guard let n = number(raw), n > 0, n / divisor < 253402300799 else { return nil }
        return Date(timeIntervalSince1970: n / divisor)
    }
    public static func parse(_ data: Data) throws -> [String: Entry] {
        guard data.count <= maxBytes else { throw LocalFailure("缓存超过 1 MiB 限制") }
        guard !data.isEmpty else { throw LocalFailure("缓存为空文件") }
        guard String(data: data, encoding: .utf8) != nil else { throw LocalFailure("缓存不是有效 UTF-8") }
        let value: Any
        do { value = try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) }
        catch { throw LocalFailure("缓存 JSON 截断或格式无效") }
        guard let root = value as? [String: Any] else { throw LocalFailure("缓存根节点必须是对象") }
        var entries: [String: Entry] = [:]
        for provider in Provider.all where provider.supported {
            guard let value = root[provider.id] else { continue }
            let raw = value as? [String: Any] ?? [:]
            let report = raw["report"] as? [String: Any]
            var warnings: [String] = []
            func rows(_ key: String) -> [Any] {
                guard let value = report?[key] else { return [] }
                guard let array = value as? [Any] else { warnings.append("\(key)：部分数据无法识别"); return [] }
                return array
            }
            let windows = rows("windows").enumerated().compactMap { i, item -> UsageWindow? in
                guard let w = item as? [String: Any] else { warnings.append("窗口：部分数据无法识别"); return nil }
                for key in ["used", "remaining", "limit", "resetsAt"] where w[key] != nil && !(w[key] is NSNull) && number(w[key]) == nil { warnings.append("窗口 \(i + 1)：\(key) 无效") }
                // Legacy bridge encodes summary-less CmdCode balance in limit with an explicit remaining label.
                // Preserve that balance without inventing an allocation or usage percentage.
                let balanceOnly = provider.id == "commandcode" && w["id"] as? String == "monthly-credits" && (w["label"] as? String)?.hasSuffix("（剩余）") == true
                return UsageWindow(id: "\(i)", label: safe(w["label"] as? String ?? "额度窗口"), unit: safe(w["unit"] as? String ?? ""), used: balanceOnly ? nil : number(w["used"]), remaining: number(w["remaining"]) ?? (balanceOnly ? number(w["limit"]) : nil), limit: balanceOnly ? nil : number(w["limit"]), resetsAt: date(w["resetsAt"], divisor: 1), primary: w["primary"] as? Bool ?? false)
            }
            let metrics = rows("metrics").enumerated().compactMap { i, item -> Metric? in
                guard let m = item as? [String: Any], let label = m["label"] as? String else { warnings.append("指标：部分数据无法识别"); return nil }
                let v = (m["value"] as? String) ?? number(m["value"]).map(format) ?? "—"
                let unit = m["currency"] as? String ?? m["unit"] as? String ?? ""
                return Metric(id: i, label: safe(label), value: safe([v, unit].filter { !$0.isEmpty }.joined(separator: " ")))
            }
            let notes = rows("notes").compactMap { item -> String? in
                guard let s = item as? String else { warnings.append("备注：部分数据无法识别"); return nil }; return safe(s)
            }
            if windows.contains(where: \.inconsistent) { warnings.append("remaining 与 used/limit 不一致；图标按已用量计算") }
            let error = (raw["error"] as? String) ?? (report?["error"] as? String) ?? (report == nil ? "订阅缓存缺少有效 report" : nil)
            entries[provider.id] = Entry(name: safe(report?["name"] as? String ?? provider.name), windows: windows, metrics: metrics, notes: notes, fetchedAt: date(raw["fetchedAt"], divisor: 1000), capturedAt: date(report?["capturedAt"], divisor: 1000), error: error.map(safe), warnings: Array(Set(warnings)).sorted())
        }
        return entries
    }
    public static func format(_ n: Double) -> String { String(format: "%.2f", n).replacingOccurrences(of: "\\.?0+$", with: "", options: .regularExpression) }
    public static func band(_ fraction: Double?) -> Band { guard let fraction else { return .gray }; return fraction > 0.5 ? .green : fraction >= 0.2 ? .orange : .red }
    public static func selection(native: String?, shared: Data?, entries: [String: Entry], now: Date) -> String {
        if let native, Provider.all.contains(where: { $0.id == native }) { return native }
        if let shared, let root = (try? JSONSerialization.jsonObject(with: shared)) as? [String: Any], let id = root["selected"] as? String, Provider.all.contains(where: { $0.id == id && $0.supported }) { return id }
        return Provider.all.first(where: { $0.supported && entries[$0.id]?.valid == true && [.fresh, .stale].contains(entries[$0.id]!.freshness(at: now)) })?.id ?? "codex"
    }
    public static func countdown(_ date: Date?, now: Date) -> String {
        guard let date else { return "重置时间未知" }
        let delta = date.timeIntervalSince(now)
        guard delta > 0 else { return "已到重置时间，等待更新" }
        let seconds = Int(min(delta, 253402300799))
        return "重置 \(seconds / 86400)天 \(seconds % 86400 / 3600)时 \(seconds % 3600 / 60)分 \(seconds % 60)秒"
    }
}
