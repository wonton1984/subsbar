import Foundation
import SubsCore

/// M2 card overview vs compact single view: both are projections of the same `CardModel`,
/// and every value must match the Node-generated golden file.
public enum M2Suite {
    public static func run() throws -> Int {
        var count = 0
        func check(_ name: String, _ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw LocalFailure("FAIL M2: \(name)") }
            count += 1; print("PASS M2 \(name)")
        }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixtures = root.appendingPathComponent("test/fixtures/ipc")
        func fixture(_ name: String) throws -> Wire { try Wire.parse(Data(contentsOf: fixtures.appendingPathComponent(name))) }
        let normalized = try fixture("usage-golden-normalized.json")
        let base = try fixture("config-read-synthetic.json")["config"]
        let now = Date(timeIntervalSince1970: normalized["nowMs"].number! / 1000)
        func vector(_ id: String) -> Wire { normalized["vectors"][id]["output"] }

        for decorated in [false, true] {
            let tag = decorated ? "decorated" : "golden"
            let usage = try SyntheticScenes.usage(normalized, decorated: decorated)
            let config = SyntheticScenes.config(base, enabled: SyntheticScenes.enabledIDs)
            func cards(_ id: String) -> CardModel { CardModel(providerID: id, name: id, config: config, usage: usage, now: now, expanded: false) }
            func expanded(_ id: String) -> CardModel { CardModel(providerID: id, name: id, config: config, usage: usage, now: now, expanded: true) }
            try check("\(tag) scene covers 14 providers", usage.providers.count == 14 && Set(usage.providers.map(\.id)) == Set(SyntheticScenes.providerIDs))
            for id in SyntheticScenes.providerIDs {
                let card = cards(id), compact = expanded(id)
                let header = [card.status, card.statusText, card.headline, card.freshness, card.issue ?? "", card.action ?? "", card.updated ?? "", card.placeholder ?? ""]
                let compactHeader = [compact.status, compact.statusText, compact.headline, compact.freshness, compact.issue ?? "", compact.action ?? "", compact.updated ?? "", compact.placeholder ?? ""]
                try check("\(tag) \(id) card and compact header agree", header == compactHeader && card.headlineFraction == compact.headlineFraction && card.tone == compact.tone && card.needsRepair == compact.needsRepair)
                try check("\(tag) \(id) card rows are a subset of compact rows", card.summaryMetrics.allSatisfy { row in compact.allMetrics.contains(row) } && card.allMetrics == compact.allMetrics)
                try check("\(tag) \(id) headline equals menu bar icon", card.headlineFraction == usage.providers.first { $0.id == id }?.iconFraction(at: now))
                if let primary = card.allMetrics.first(where: \.isPrimary) {
                    try check("\(tag) \(id) primary leads collapsed card", card.summaryMetrics.first == primary && card.summaryMetrics.count <= 2)
                }
            }
            func primary(_ id: String) -> MetricDisplay? { cards(id).summaryMetrics.first }
            for (id, vectorID) in [("codex", "zero"), ("opencode", "inconsistent"), ("kimi", "over-limit"), ("droid", "zero-denominator"), ("commandcode", "remaining-only")] {
                let output = vector(vectorID)
                try check("\(tag) \(vectorID) used percent equals golden", primary(id)?.usedPercent == output["usedPercent"].number)
                try check("\(tag) \(vectorID) bar fraction equals golden", primary(id)?.fraction == output["iconFraction"].number)
                try check("\(tag) \(vectorID) summary equals V1Metric", primary(id)?.summary == V1Metric(output).summary)
                try check("\(tag) \(vectorID) unknown bar is gray not zero", output["iconFraction"].number != nil || primary(id)?.band == .gray)
            }
            try check("\(tag) zero stays full", primary("codex")?.fraction == 1 && cards("codex").headline == "100%")
            try check("\(tag) over-limit shows overage and clips bar", primary("kimi")?.overage?.contains("150") == true && primary("kimi")?.fraction == 0 && cards("kimi").headline == "0%")
            try check("\(tag) remaining-only invents no percentage", primary("commandcode")?.summary == "剩 USD 12.50" && primary("commandcode")?.fraction == nil && cards("commandcode").headline == "未知")
            try check("\(tag) zero denominator unknown", primary("droid")?.fraction == nil && cards("droid").headline == "未知")
            try check("\(tag) inconsistent flagged, used fraction kept", primary("opencode")?.inconsistent == true && primary("opencode")?.fraction == vector("inconsistent")["iconFraction"].number)
            let wallet = cards("cursor").summaryMetrics
            try check("\(tag) balance only shown without bar", wallet.count == 1 && wallet[0].summary == "USD 42.00" && !wallet[0].showsBar && cards("cursor").headline == "未知")
            let claude = cards("claude")
            try check("\(tag) primary unknown never replaced by secondary", claude.summaryMetrics.first?.isPrimary == true && claude.summaryMetrics.first?.fraction == nil
                      && claude.summaryMetrics.last?.fraction == vector("primary-unknown")["secondary"]["iconFraction"].number && claude.headline == "未知")
            try check("\(tag) stale failure stays visible with error", claude.status == "stale" && claude.issue == Presentation.error("network") && claude.freshness == "stale" && claude.freshnessNote != nil)
            try check("\(tag) retry-later is not offered as a repair", !claude.needsRepair && !cards("copilot").needsRepair)
            let copilot = cards("copilot")
            try check("\(tag) rate-limited fresh cache keeps value", copilot.status == "rate-limited" && copilot.freshness == vector("rate-limited-fresh-cache")["computedFreshness"].text && copilot.headlineFraction == 1)
            try check("\(tag) expired cache gray headline", cards("zai").freshness == vector("expired-cache")["computedFreshness"].text && cards("zai").headlineFraction == nil)
            try check("\(tag) future clock invalid", cards("openrouter").freshness == vector("future-clock")["computedFreshness"].text && cards("openrouter").headlineFraction == nil && cards("openrouter").updated == "采样时间异常")
            try check("\(tag) legacy is not a percentage", cards("antigravity").freshness == vector("legacy-commandcode")["freshness"].text && cards("antigravity").summaryMetrics.first?.fraction == nil && cards("antigravity").headline == "未知")
            try check("\(tag) reauth-required card offers repair", cards("devin").needsRepair && cards("devin").allMetrics.isEmpty && cards("devin").tone == .critical)
            try check("\(tag) not-configured card offers connect", cards("grok").needsRepair && cards("grok").issue == Presentation.error("not-configured"))
            try check("\(tag) disabled provider stripped", !cards("ollama").enabled && cards("ollama").allMetrics.isEmpty && cards("ollama").status == "disabled")
        }

        let usage = try SyntheticScenes.usage(normalized, decorated: true)
        let config = SyntheticScenes.config(base, enabled: SyntheticScenes.enabledIDs)
        func card(_ config: Wire, _ id: String, expanded: Bool) -> CardModel { CardModel(providerID: id, name: id, config: config, usage: usage, now: now, expanded: expanded) }
        let hiding = config.setting("ui", config["ui"].setting("cards", .object(["codex": .object(["hiddenMetricIds": .strings(["secondary"])])])))
        try check("hidden metric honored in both views", card(hiding, "codex", expanded: false).allMetrics.map(\.id) == ["quota-percent"] && card(hiding, "codex", expanded: true).allMetrics.map(\.id) == ["quota-percent"])
        let hidePrimary = config.setting("ui", config["ui"].setting("cards", .object(["codex": .object(["hiddenMetricIds": .strings(["quota-percent"])])])))
        let hidden = card(hidePrimary, "codex", expanded: false)
        try check("hidden primary flagged, headline still primary", hidden.primaryHidden && hidden.summaryMetrics.map(\.id) == ["secondary"] && hidden.headline == card(config, "codex", expanded: false).headline)
        let ordered = config.setting("ui", config["ui"].setting("cards", .object(["codex": .object(["metricOrder": .strings(["secondary", "quota-percent"])])])))
        try check("metric order honored, primary still leads collapsed card", card(ordered, "codex", expanded: true).allMetrics.map(\.id) == ["secondary", "quota-percent"] && card(ordered, "codex", expanded: false).summaryMetrics.first?.id == "quota-percent")
        try check("reset countdown short and full agree on known reset", card(config, "codex", expanded: false).summaryMetrics[0].resetShort == "2时13分后重置" && card(config, "codex", expanded: false).summaryMetrics[0].resetFull == "重置 0天 2时 13分 0秒")
        try check("unknown reset explicit", card(config, "droid", expanded: false).summaryMetrics[0].resetShort == "重置时间未知")
        try check("relative freshness text", card(config, "codex", expanded: false).updated == "2 分钟前更新" && card(config, "claude", expanded: false).updated == "45 分钟前更新")

        let registry = SyntheticScenes.providerIDs.map { Wire.object(["providerId": .string($0), "name": .string($0)]) }
        let sections = ProviderSections(registry: registry, config: config)
        try check("every provider discoverable in cards or add list", Set(sections.cards + sections.available) == Set(SyntheticScenes.providerIDs) && sections.cards.count + sections.available.count == 14)
        try check("failing enabled providers stay in cards", ["claude", "devin", "grok", "zai"].allSatisfy(sections.cards.contains))
        try check("disabled provider listed under add subscription", sections.available == ["ollama"])
        try check("cards follow providerOrder", sections.cards == SyntheticScenes.enabledIDs)
        let empty = ProviderSections(registry: registry, config: SyntheticScenes.config(base, enabled: []))
        try check("empty home lists all 14 under add subscription", empty.cards.isEmpty && empty.available.count == 14)

        let pin = Wire.object(["providerId": .string("commandcode"), "profileId": .string("personal"), "metricId": .string("monthly-credits"), "field": .string("remaining"), "style": .string("text")])
        try check("pinned remaining-only shows balance, not percent", PinnedMetric(pin: pin, usage: usage, enabled: true, now: now).text == "USD 12.50")
        try check("pinned unknown primary stays unknown", PinnedMetric(pin: pin.setting("providerId", .string("claude")).setting("metricId", .string("quota-percent")).setting("field", .string("remaining-percent")), usage: usage, enabled: true, now: now).text == "—")
        try check("pin limit is two", PinnedMetric.limit == 2)
        return count
    }
}
