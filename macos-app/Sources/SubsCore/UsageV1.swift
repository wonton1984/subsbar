import Foundation

public enum Presentation {
    public static func text(_ value: String, limit: Int = 160) -> String {
        // Wire labels are already schema-controlled; scrub again at the display boundary.
        Cache.safe(String(value.prefix(limit)))
    }
    public static func amount(_ value: Double, currency: String? = nil) -> String {
        let number = value > 0 && value < 0.01 ? "<0.01" : currency != nil ? String(format: "%.2f", value) : Cache.format(value)
        return currency.map { "\($0) \(number)" } ?? number
    }
    public static func error(_ code: String) -> String {
        switch code {
        case "not-configured": "尚未连接：选择凭证来源后连接"
        case "invalid-credential": "凭证无效：检查所选来源或在原应用重新登录"
        case "credential-expired": "凭证已过期：请在原应用重新登录"
        case "permission-denied": "访问被拒：检查所选来源的读取权限"
        case "account-mismatch": "账户不一致：请选择正确的账户配置"
        case "interaction-required": "需要操作：打开连接设置后重试"
        case "config-conflict": "配置已被其他程序修改。重新载入后再保存；本次草稿未覆盖文件。"
        case "invalid-config": "配置无效：在设置中修正；刷新已暂停"
        case "schema-unsupported": "配置或数据版本不支持，请更新应用"
        case "cache-write-failed": "数据未保存：检查本地存储权限"
        case "rate-limited": "服务限流：等待重试时间，手动刷新不会绕过限制"
        case "network", "timeout": "连接暂时失败：稍后重试"
        case "unsupported": "此来源尚未支持或未通过准入，请选择已支持的来源"
        case "cancelled": "刷新已取消"
        case "invalid-response": "部分数据无法识别，请更新客户端或稍后重试"
        default: "操作未完成：检查设置或稍后重试"
        }
    }
    public static func action(_ code: String) -> String {
        switch code {
        case "configure-source": "选择凭证来源"
        case "select-profile": "选择账户配置"
        case "allow-source": "检查来源许可"
        case "relogin-owner": "在原应用重新登录"
        case "check-permission": "检查读取权限"
        case "check-plan-region": "检查套餐与地区"
        case "update-client": "更新客户端"
        case "retry-later": "等待后重试"
        case "contact-maintainer": "联系维护者"
        default: "打开连接设置"
        }
    }
    public static func diagnostic(_ code: String) -> String {
        switch code {
        case "inconsistent-values": "数值不一致，比例按已用量计算"
        case "summary-unavailable": "本周期用量不可用，仅保留已知数据"
        case "reset-unknown": "重置时间未知"
        case "legacy-unverified": "历史导入，未经当前账户验证"
        case "missing-data": "部分数据缺失"
        case "clock-invalid": "数据时间异常"
        default: "部分数据或能力不可用"
        }
    }
    public static func status(_ code: String) -> String {
        switch code {
        case "disabled": "未启用"
        case "not-configured": "未连接"
        case "ok": "正常"
        case "partial": "部分数据"
        case "stale": "上次数据"
        case "reauth-required": "需要重新登录"
        case "permission-denied": "权限不足"
        case "rate-limited": "限流中"
        case "unsupported": "尚不支持"
        case "error": "数据错误"
        default: "协议状态未知"
        }
    }
}
public struct V1Metric: Sendable, Identifiable {
    public let raw: Wire
    public let valid: Bool
    public var id: String { raw["id"].text }
    public var label: String { Presentation.text(raw["label"].text) }
    public var unit: String { raw["unit"].text }
    public var currency: String? { unit == "currency" ? raw["currency"].string : nil }
    public var kind: String { raw["kind"].text }
    public var used: Double? { valid ? raw["used"].number : nil }
    public var limit: Double? { valid ? raw["limit"].number : nil }
    public var remaining: Double? { valid ? raw["remaining"].number : nil }
    public init(_ raw: Wire) {
        self.raw = raw
        let unit = raw["unit"].text, kind = raw["kind"].text, state = raw["state"].text
        let keys = ["used", "remaining", "limit"]
        let present = keys.filter { raw.object[$0] != nil }
        let numbers = keys.filter { raw[$0].number != nil }
        var ok = !raw["id"].text.isEmpty && raw.isObject && raw["label"].string != nil && ["percent","count","tokens","requests","credits","currency","none"].contains(unit)
        if unit == "currency" { ok = ok && raw["currency"].text.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil }
        if kind == "quota" {
            let expected = numbers.isEmpty ? "unknown" : numbers.count >= 2 ? "known" : numbers[0] == "used" ? "used-only" : numbers[0] == "remaining" ? "remaining-only" : "limit-only"
            ok = ok && unit != "none" && present.count == numbers.count && state == expected
            ok = ok && ["unknown","within-limit","at-limit","over-limit"].contains(raw["quotaState"].text)
            if ["count","tokens","requests"].contains(unit) { ok = ok && numbers.allSatisfy { raw[$0].number!.rounded() == raw[$0].number! } }
            if unit == "percent", raw["used"].number != nil { ok = ok && raw["limit"].number == 100 }
            let period = raw["period"]
            ok = ok && ["rolling","calendar","billing","lifetime","unknown"].contains(period["kind"].text) && ["known","unknown","not-started"].contains(period["resetState"].text)
            if period["resetState"].text == "known" { ok = ok && Self.timestamp(period["resetsAtMs"]) != nil }
            for key in ["startsAtMs","endsAtMs","resetsAtMs"] where period.object[key] != nil { ok = ok && Self.timestamp(period[key]) != nil }
            if let start = period["startsAtMs"].number, let end = period["endsAtMs"].number { ok = ok && start < end }
        } else if ["balance","spend","counter","status"].contains(kind) {
            ok = ok && ["known","unknown"].contains(state) && present.isEmpty
            if state == "unknown" { ok = ok && raw.object["value"] == nil && raw.object["valueCode"] == nil }
            else if kind == "status" { ok = ok && unit == "none" && raw.object["value"] == nil && ["available","unavailable","unlimited","enabled","disabled"].contains(raw["valueCode"].text) }
            else { ok = ok && raw["value"].number != nil && raw.object["valueCode"] == nil }
            if kind == "spend" { ok = ok && raw["period"].isObject }
        } else { ok = false }
        valid = ok
    }
    public static func timestamp(_ value: Wire) -> Double? {
        guard let n = value.number, n > 0, n < 253402300799000, n.rounded() == n else { return nil }; return n
    }
    public var usedPercent: Double? {
        guard valid, kind == "quota", let used else { return nil }
        if unit == "percent" { return used }
        guard let limit, limit > 0 else { return nil }; return used / limit * 100
    }
    public var fraction: Double? { usedPercent.map { max(0, min(1, (100 - $0) / 100)) } }
    public var inconsistent: Bool {
        if let used, let limit, let remaining { return abs(used + remaining - limit) > max(0.001, limit * 0.001) }
        if used == nil, let remaining, let limit { return remaining > limit }; return false
    }
    public var summary: String {
        guard valid else { return "指标不支持或数据无效" }
        if kind == "status" { return ["available":"可用","unavailable":"不可用","unlimited":"无限","enabled":"已启用","disabled":"未启用"][raw["valueCode"].text] ?? "未知" }
        if kind != "quota" { return raw["value"].number.map { Presentation.amount($0, currency: currency) } ?? "未知" }
        if let used, let limit { return "已用 \(Presentation.amount(used)) / \(Presentation.amount(limit, currency: currency))\(unit == "percent" ? " %" : "")" }
        if let remaining { return "剩 \(Presentation.amount(remaining, currency: currency))" }
        if let used { return "已用 \(Presentation.amount(used, currency: currency)) · 总额未知" }
        if let limit { return "总额 \(Presentation.amount(limit, currency: currency)) · 已用未知" }
        return "额度未知"
    }
    public func reset(at now: Date) -> String {
        guard valid else { return "" }
        if raw["period"]["resetState"].text == "not-started" { return "窗口尚未激活" }
        guard let ms = Self.timestamp(raw["period"]["resetsAtMs"]), raw["period"]["resetState"].text == "known" else { return "重置时间未知" }
        return Cache.countdown(Date(timeIntervalSince1970: ms / 1000), now: now)
    }
}
public struct V1Provider: Identifiable, Sendable {
    public let raw: Wire
    public let invalid: Bool
    public var id: String { raw["providerId"].text }
    public var profile: String { raw["profileId"].text }
    public var scope: String { raw["scopeKey"].text }
    public var status: String { invalid ? "error" : raw["status"].text }
    public var report: Wire { invalid || status == "disabled" ? .null : raw["report"] }
    public var windows: [V1Metric] { report["windows"].array.map(V1Metric.init) }
    public var metrics: [V1Metric] { report["metrics"].array.map(V1Metric.init) }
    public var primary: V1Metric? { windows.first { $0.id == report["primaryMetricId"].text } }
    public init(_ raw: Wire, invalid: Bool = false) {
        self.raw = raw
        let report = raw["report"]
        let ids = (report["windows"].array + report["metrics"].array).map { $0["id"].text }
        let successMissing = raw["dataDisposition"].text != "legacy" && V1Metric.timestamp(raw["lastSuccessAtMs"]) == nil
        let reportBad = report.isObject && (raw["scopeKey"].text.isEmpty || !raw["source"].isObject || successMissing || !report["windows"].isArray || !report["metrics"].isArray || ids.count > 128 || Set(ids).count != ids.count || ids.contains(""))
        self.invalid = invalid || !raw.isObject || reportBad
    }
    public func freshness(at now: Date) -> String {
        guard report.isObject else { return "none" }
        if raw["dataDisposition"].text == "legacy" {
            return V1Metric.timestamp(report["observedAtMs"]) != nil || V1Metric.timestamp(report["capturedAtMs"]) != nil ? "expired" : "invalid"
        }
        let basis = report["observationBasis"].text
        let stamp = basis == "local-snapshot" ? V1Metric.timestamp(report["observedAtMs"]) : V1Metric.timestamp(report["observedAtMs"]) ?? V1Metric.timestamp(report["capturedAtMs"])
        guard let stamp, ["remote-response","cli-response","local-snapshot"].contains(basis) else { return "invalid" }
        let age = now.timeIntervalSince1970 * 1000 - stamp
        if age < -300000 { return "invalid" }; return age >= 86400000 ? "expired" : age > 600000 ? "stale" : "fresh"
    }
    public func iconFraction(at now: Date) -> Double? {
        guard ["ok","partial","stale","reauth-required","permission-denied","rate-limited"].contains(status), ["fresh","stale"].contains(freshness(at: now)), ["current","last-good"].contains(raw["dataDisposition"].text) else { return nil }
        return primary?.fraction
    }
    public var issue: String? {
        if invalid { return Presentation.error("invalid-response") }
        if raw["error"].isObject { return Presentation.error(raw["error"]["code"].text) }
        if !["disabled","not-configured","ok","partial","stale","reauth-required","permission-denied","rate-limited","unsupported","error"].contains(status) { return "协议状态未知，请更新应用" }
        return nil
    }
    public var attemptMessage: String? {
        switch raw["attempt"]["state"].text {
        case "running": "刷新中"
        case "deferred": switch raw["attempt"]["deferredReason"].text { case "busy": "其他刷新进行中"; case "backoff": "等待退避时间"; case "auth-wait": "等待修复连接"; case "not-due": "尚未到刷新时间"; default: "等待调度" }
        case "cancelled": "本次刷新已取消"
        case "failed": "本次刷新失败"
        case "partial": "本次仅部分更新"
        default: nil
        }
    }
}
public struct UsageV1: Sendable {
    public let context: String, revision: Double, providers: [V1Provider], raw: Wire
    public init(_ wire: Wire) throws {
        guard wire["schemaVersion"].number == 1, wire["kind"].text == "usage" else { throw LocalFailure("schema-unsupported") }
        guard !wire["contextId"].text.isEmpty, let revision = wire["cacheRevision"].number, revision.rounded() == revision, wire["providers"].isArray, wire["providers"].array.count <= 128 else { throw LocalFailure("invalid-response") }
        self.raw = wire; context = wire["contextId"].text; self.revision = revision
        let rows = wire["providers"].array
        let counts = Dictionary(grouping: rows, by: { $0["providerId"].text }).mapValues(\.count)
        providers = rows.enumerated().filter { index, row in !rows.prefix(index).contains { $0["providerId"].text == row["providerId"].text } }.map { V1Provider($0.element, invalid: counts[$0.element["providerId"].text] != 1) }
    }
    /// Explain a fully deferred request using Node deadlines, never recomputing backoff locally.
    public func backoffNotice(at now: Date, enabledIDs: [String]) -> String? {
        let request = raw["request"]
        guard request["outcome"].text == "deferred" else { return nil }
        let requested = request["requestedProviderIds"].array.map(\.text)
        let targets = enabledIDs.filter { requested.contains($0) }
        guard !targets.isEmpty else { return nil }
        let rows = targets.compactMap { id in providers.first { $0.id == id } }
        guard rows.count == targets.count, rows.allSatisfy({ !$0.invalid && $0.raw["attempt"]["state"].text == "deferred" && $0.raw["attempt"]["deferredReason"].text == "backoff" }) else { return nil }
        let deadlines = rows.compactMap { row -> Double? in
            let values = [V1Metric.timestamp(row.raw["nextEligibleAtMs"]), V1Metric.timestamp(row.raw["error"]["retryAtMs"])].compactMap { $0 }
            return values.max()
        }
        guard deadlines.count == rows.count, let earliest = deadlines.min() else { return "刷新暂缓：退避中，重试时间未知" }
        guard earliest > now.timeIntervalSince1970 * 1000 else { return "退避等待已结束，可点击刷新重试" }
        // Round upward: HH:mm must not promise eligibility before the actual deadline.
        let date = Date(timeIntervalSince1970: ceil(earliest / 60_000) * 60)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = Calendar.current.isDate(date, inSameDayAs: now) ? "HH:mm" : "MM-dd HH:mm"
        return "刷新暂缓：全部所选订阅退避中，最早 " + formatter.string(from: date) + " 后可重试"
    }
    public var receiptText: String? {
        let request = raw["request"]
        if raw["coordinatorError"].isObject { return Presentation.error(raw["coordinatorError"]["code"].text) }
        guard request.isObject else { return nil }
        let outcome = ["updated":"本次数据已更新","unchanged":"数据未变化","partial":"本次部分更新","failed":"本次刷新失败","deferred":"等待其他刷新或重试时间","cancelled":"本次刷新已取消","no-op":"没有已启用的订阅"][request["outcome"].text] ?? "刷新结果未知"
        return outcome + (request["cachePersisted"].bool ? "" : " · 本次未写入缓存")
    }
}
