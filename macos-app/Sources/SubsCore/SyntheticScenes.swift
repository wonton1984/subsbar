import Foundation

/// Synthetic usage-v1 envelope assembled from the Node-generated golden file.
/// Metric values come verbatim from `usage-golden-normalized.json`; `decorated` only swaps labels
/// and adds reset times for screenshots. No credentials, config writes or provider requests.
public enum SyntheticScenes {
    public static let providerIDs = ["codex", "opencode", "kimi", "commandcode", "droid", "cursor", "claude", "copilot", "zai", "openrouter", "antigravity", "devin", "grok", "ollama"]
    /// Enabled in the scene config; `ollama` stays disabled to exercise the add-subscription list.
    public static let enabledIDs = Array(providerIDs.dropLast())

    public static func usage(_ normalized: Wire, decorated: Bool) throws -> UsageV1 {
        try UsageV1(.object(["schemaVersion": .number(1), "kind": .string("usage"), "contextId": .string("context-synthetic-default"), "cacheRevision": .number(1),
                             "generatedAtMs": normalized["nowMs"], "providers": .array(rows(normalized, decorated: decorated)), "diagnostics": .array([])]))
    }

    public static func config(_ base: Wire, enabled: [String]) -> Wire {
        var providers: [String: Wire] = [:]
        for id in providerIDs {
            providers[id] = .object(["enabled": .bool(enabled.contains(id)), "dataSource": .string("auto"), "allowCommunityEndpoints": .bool(false), "activeProfile": .string("personal"),
                                     "profiles": .array([.object(["id": .string("personal"), "label": .string("合成账户"), "discovery": .string("only"), "sources": .array([])])])])
        }
        return base.setting("providers", .object(providers))
    }

    public static func rows(_ normalized: Wire, decorated: Bool) -> [Wire] {
        let now = normalized["nowMs"].number ?? 0
        func vector(_ id: String) -> Wire { normalized["vectors"][id]["output"] }
        func metric(_ value: Wire, id: String? = nil, label: String, resetInMs: Double? = nil) -> Wire {
            var out = value
            if let id { out = out.setting("id", .string(id)) }
            guard decorated else { return out }
            out = out.setting("label", .string(label))
            if let resetInMs { out = out.setting("period", out["period"].setting("resetState", .string("known")).setting("resetsAtMs", .number(now + resetInMs))) }
            return out
        }
        func row(_ id: String, status: String, windows: [Wire] = [], metrics: [Wire] = [], primary: String? = nil, capturedAtMs: Double? = nil,
                 disposition: String = "current", error: Wire? = nil, diagnostics: [String] = [], attempt: String? = nil, report: Bool = true) -> Wire {
            var fields: [String: Wire] = ["providerId": .string(id), "profileId": .string("personal"), "status": .string(status), "dataDisposition": .string(report ? disposition : "none")]
            if report {
                var body: [String: Wire] = ["capturedAtMs": .number(capturedAtMs ?? now - 120_000), "observationBasis": .string("remote-response"),
                                            "windows": .array(windows), "metrics": .array(metrics),
                                            "diagnostics": .array(diagnostics.map { .object(["code": .string($0), "severity": .string("warning")]) })]
                if let primary { body["primaryMetricId"] = .string(primary) }
                fields["report"] = .object(body)
                fields["scopeKey"] = .string("scope-synthetic-\(id)")
                fields["source"] = .object(["dataSourceId": .string("\(id)-synthetic")])
                if disposition != "legacy" { fields["lastSuccessAtMs"] = .number(min(now, capturedAtMs ?? now - 120_000)) }
            }
            if let error { fields["error"] = error }
            if let attempt { fields["attempt"] = .object(["state": .string(attempt)]) }
            return .object(fields)
        }
        let unknownPair = vector("primary-unknown")
        let hour = 3_600_000.0
        return [
            row("codex", status: "ok", windows: [metric(vector("zero"), label: "5 小时窗口", resetInMs: 2 * hour + 13 * 60_000),
                                                  metric(unknownPair["secondary"], label: "每周窗口", resetInMs: 76 * hour)], primary: "quota-percent"),
            row("opencode", status: "ok", windows: [metric(vector("inconsistent"), label: "月度额度", resetInMs: 9 * 24 * hour)], primary: "quota-count"),
            row("kimi", status: "ok", windows: [metric(vector("over-limit"), label: "5 小时窗口", resetInMs: 41 * 60_000)], primary: "quota-count"),
            row("commandcode", status: "partial", windows: [metric(vector("remaining-only"), label: "月度 credits（剩余）")], primary: "monthly-credits", diagnostics: ["summary-unavailable"]),
            row("droid", status: "ok", windows: [metric(vector("zero-denominator"), label: "标准额度")], primary: "quota-count"),
            row("cursor", status: "partial", metrics: vector("partial-balance")["metrics"].array.map { metric($0, label: "账户余额") }),
            row("claude", status: vector("stale-network")["status"].text, windows: [metric(unknownPair["primary"], label: "会话窗口"), metric(unknownPair["secondary"], label: "每周窗口", resetInMs: 5 * 24 * hour)],
                primary: unknownPair["primaryMetricIdStays"].text == "primary" ? "quota-percent" : nil, capturedAtMs: now - 45 * 60_000,
                disposition: vector("stale-network")["dataDisposition"].text, error: vector("stale-network")["error"], attempt: "failed"),
            row("copilot", status: vector("rate-limited-fresh-cache")["status"].text, windows: [metric(vector("zero"), label: "月度请求", resetInMs: 12 * 24 * hour)], primary: "quota-percent",
                capturedAtMs: now - (vector("rate-limited-fresh-cache")["capturedAgeMs"].number ?? 0), disposition: vector("rate-limited-fresh-cache")["dataDisposition"].text,
                error: vector("rate-limited-fresh-cache")["error"]),
            row("zai", status: "stale", windows: [metric(vector("inconsistent"), label: "5 小时窗口")], primary: "quota-count",
                capturedAtMs: now - (vector("expired-cache")["capturedAgeMs"].number ?? 0), disposition: "last-good", error: vector("stale-network")["error"]),
            row("openrouter", status: "ok", windows: [metric(vector("zero"), label: "Key 额度")], primary: "quota-percent", capturedAtMs: vector("future-clock")["capturedAtMs"].number),
            row("antigravity", status: "stale", windows: [metric(vector("legacy-commandcode")["metric"], label: "历史导入额度")], primary: "monthly-credits",
                capturedAtMs: now - 2 * 24 * hour, disposition: vector("legacy-commandcode")["dataDisposition"].text, diagnostics: ["legacy-unverified"]),
            row("devin", status: "reauth-required", error: .object(["code": .string("credential-expired"), "action": .string("relogin-owner")]), report: false),
            row("grok", status: "not-configured", error: .object(["code": .string("not-configured"), "action": .string("configure-source")]), report: false),
            row("ollama", status: "disabled", report: false)
        ]
    }
}
