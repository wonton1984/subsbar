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
        for n in [0, 1, 3, 4, 6, 14] {
            let layout = OverviewLayout(count: n)
            let ids = (0..<n).map(String.init)
            try check("layout threshold \(n)", layout.columns == (n > 3 ? 2 : 1))
            try check("layout ordered rows \(n)", layout.rows(ids).flatMap { $0 } == ids && layout.rows(ids).allSatisfy { $0.count <= layout.columns })
            try check("layout width \(n)", layout.width == (n > 3 ? 560 : 360))
            try check("single unchanged \(n)", OverviewLayout(count: n, single: true).width == 360)
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
                try check("grid primary only \(tag) \(id)", card.displayedMetrics(compact: true).count <= 1 && card.displayedMetrics(compact: true).allSatisfy(\.isPrimary))
                try check("grid expanded metrics unchanged \(tag) \(id)", compact.displayedMetrics(compact: true) == compact.allMetrics)
                try check("single metrics unchanged \(tag) \(id)", card.displayedMetrics(compact: false) == card.metrics)
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

        let home = try fixture("registry-empty-home.json")["providers"].array
        func manifest(_ id: String, supported: Bool = true, kinds: [String] = [], login: Wire? = nil, service: String? = nil) -> Wire {
            var fields: [String: Wire] = ["providerId": .string(id), "supported": .bool(supported)]
            fields["credentialReaders"] = .array(kinds.map { kind in
                var reader: [String: Wire] = ["id": .string("synthetic-key-reader"), "implemented": .bool(true), "purposes": .array([.string("primary")]), "credentialKinds": .array([.string(kind)]), "kind": .string("keychain"), "owner": .string("subsbar")]
                if let service { reader["credentialService"] = .string(service) }
                return .object(reader)
            })
            if let login { fields["login"] = login }
            return .object(fields)
        }
        func guide(_ m: Wire, _ name: String? = nil) -> ConnectionGuide { ConnectionGuide(manifest: m, name: name ?? m["providerId"].text.capitalized) }
        let verified = Wire.object(["mode": .string("command"), "note": .string("Manage login"), "verified": .bool(true), "command": .string("codex"), "args": .array([.string("login")])])
        let codex = guide(manifest("codex", login: verified))
        try check("guide verified projection gives button, command and one sentence", codex.kind == .login && codex.primaryTitle == "登录 Codex" && codex.command == "codex login" && codex.instruction.contains("codex login") && !codex.unverified)
        let multiArg = guide(manifest("claude", login: .object(["mode": .string("command"), "verified": .bool(true), "command": .string("claude"), "args": .array([.string("auth"), .string("login")])])))
        try check("guide joins projected args", multiArg.command == "claude auth login")
        let interactive = guide(manifest("droid", login: .object(["mode": .string("command"), "verified": .bool(true), "command": .string("droid"), "args": .array([])])))
        try check("guide command without args", interactive.command == "droid")
        let guideOnly = guide(manifest("grok", login: .object(["mode": .string("guide"), "note": .string("文档为 grok login"), "verified": .bool(false), "url": .string("https://x.ai")])))
        try check("guide-only projection has text and URL, no command, marked verifying", guideOnly.command == nil && guideOnly.url == "https://x.ai" && guideOnly.unverified && guideOnly.instruction.contains("文档为 grok login"))
        let unverifiedCommand = guide(manifest("grok", login: .object(["mode": .string("command"), "verified": .bool(false), "command": .string("grok"), "args": .array([.string("login")])])))
        try check("unverified command never becomes a button command", unverifiedCommand.command == nil)
        let verifiedGuide = guide(manifest("cursor", login: .object(["mode": .string("guide"), "note": .string("在 Cursor IDE 内登录"), "verified": .bool(true)])))
        try check("verified guide-only is not marked unverified", verifiedGuide.kind == .login && !verifiedGuide.unverified && verifiedGuide.command == nil)
        try check("guide falls back to plain text when registry has no login", guide(manifest("droid")).command == nil && guide(manifest("droid")).instruction.contains("检测连接"))
        try check("guide unsupported provider has no action", guide(manifest("claude", supported: false)).kind == .unsupported && guide(manifest("claude", supported: false)).command == nil)
        try check("guide api-key providers use declared capabilities", ["kimi", "openrouter", "commandcode", "opencode", "zai"].allSatisfy { guide(manifest($0, kinds: ["api-key"])).kind == .apiKey })
        try check("guide login providers", ["codex", "claude", "droid", "antigravity", "devin", "grok", "ollama", "copilot"].allSatisfy { guide(manifest($0)).kind == .login })
        try check("guide unknown provider classified by credential kind", guide(manifest("x-new", kinds: ["api-key"])).kind == .apiKey && guide(manifest("y-new", kinds: ["oauth"])).kind == .login)
        let template = "SubsBar credential <providerId>"
        let keyManifest = manifest("kimi", kinds: ["api-key"], login: verified, service: "SubsBar credential kimi")
        let keyGuide = guide(keyManifest, "Kimi")
        try check("api-key guide uses final service unchanged", keyGuide.canPasteKey && keyGuide.credentialService == "SubsBar credential kimi")
        try check("unrendered service is refused, never expanded", !guide(manifest("kimi", kinds: ["api-key"], service: template)).canPasteKey)
        let pendingReader = keyManifest["credentialReaders"].array[0].setting("implemented", .bool(false))
        try check("unimplemented writer is not offered", !guide(keyManifest.setting("credentialReaders", .array([pendingReader]))).canPasteKey)
        let quoted = guide(manifest("synthetic", login: verified.setting("args", .array([.string("login; echo unsafe")]))))
        try check("copied command quotes arguments", quoted.command == "codex 'login; echo unsafe'")
        try check("non-https guide links are not opened", guide(manifest("synthetic", login: verified.setting("url", .string("file:///tmp/synthetic")))).url == nil)
        try check("api-key guide without annotated reader cannot paste", !guide(manifest("kimi", kinds: ["api-key"])).canPasteKey && !guide(manifest("codex", kinds: ["oauth"], service: template)).canPasteKey)
        let developerWords = ["reader", "source", "priority", "profile", "keychain", "discovery"]
        let texts = [codex, guideOnly, keyGuide, guide(manifest("droid"))].flatMap { [$0.primaryTitle, $0.instruction] }
        try check("guide default copy has no developer terms", !texts.contains { text in developerWords.contains { text.lowercased().contains($0) } })

        final class MockStore: CredentialStore, @unchecked Sendable {
            let lock = NSLock(); var saved: [(service: String, account: String, label: String, secret: Data)] = []; var failure: Error?
            func save(service: String, account: String, label: String, secret: Data) throws {
                if let failure { throw failure }
                lock.lock(); saved.append((service, account, label, secret)); lock.unlock()
            }
        }
        struct Leaky: Error, CustomStringConvertible { let description: String }
        let mock = MockStore(), writer = CredentialWriter(store: mock)
        try writer.save(guide: keyGuide, profileID: "personal", key: "  synthetic-key-body\n")
        try check("keychain write follows frozen naming, key body only", mock.saved.count == 1 && mock.saved[0].service == "SubsBar credential kimi" && mock.saved[0].account == "kimi:personal" && String(decoding: mock.saved[0].secret, as: UTF8.self) == "synthetic-key-body")
        try check("keychain label carries no account identifier", mock.saved[0].label == "SubsBar credential" && !mock.saved[0].label.contains("personal"))
        let connection = try CredentialWriter.connectionDraft(.object(["profiles": .array([])]), guide: keyGuide, profileID: "chosen-profile")
        let selected = connection["profiles"].array[0]
        try check("new key connection creates and activates current form profile", connection["enabled"].bool && connection["activeProfile"].text == "chosen-profile" && selected["id"].text == "chosen-profile")
        try check("connection reference matches keychain destination", selected["sources"].array[0]["service"].text == "SubsBar credential kimi" && selected["sources"].array[0]["account"].text == "kimi:chosen-profile" && selected["allowKeychain"].bool && selected["discovery"].text == "only")
        try check("config patch contains no key material", !String(decoding: try connection.encoded(), as: UTF8.self).contains("synthetic-key-body"))
        let otherProfile = Wire.object(["id": .string("other"), "label": .string("untouched")])
        let replacement = try CredentialWriter.connectionDraft(connection.setting("profiles", .array([selected, otherProfile])), guide: keyGuide, profileID: "chosen-profile")
        try check("key replacement preserves other profiles", replacement["profiles"].array.count == 2 && replacement["profiles"].array[1] == otherProfile && replacement["profiles"].array[0]["sources"].array.count == 1)
        func rejected(_ run: () throws -> Void) -> String? { do { try run(); return nil } catch { return String(describing: error) } }
        try check("empty and control-character keys never reach the store", rejected { try writer.save(guide: keyGuide, profileID: "p", key: "   ") } == "credential-invalid" && rejected { try writer.save(guide: keyGuide, profileID: "p", key: "a\u{0007}b") } == "credential-invalid" && mock.saved.count == 1)
        try check("provider without key channel is refused", rejected { try writer.save(guide: codex, profileID: "p", key: "x") } == "credential-unsupported" && mock.saved.count == 1)
        mock.failure = Leaky(description: "boom synthetic-private-value at /tmp/synthetic-account")
        let failure = rejected { try writer.save(guide: keyGuide, profileID: "p", key: "synthetic-private-value") }
        try check("store failure surfaces a fixed code without key or path", failure == "credential-save-failed" && !(failure ?? "").contains("synthetic-private-value"))
        let resolved = Wire.object(["supported": .bool(true), "credentialReaders": home[0]["credentialReaders"], "profiles": .array([.object(["sources": .array([
            .object(["reader": .string("codex-auth-file"), "availability": .string("missing")]),
            .object(["reader": .string("codex-official"), "availability": .string("resolved")])])])])])
        try check("connected source is one user sentence", ConnectionGuide.sourceSentence(manifest: resolved, name: "Codex") == "凭证来源：Codex 命令行登录")
        try check("no resolved source gives no sentence", ConnectionGuide.sourceSentence(manifest: home[0], name: "Codex") == nil)
        try check("resolved source primary is detect", guide(resolved, "Codex").prefersDetect && guide(resolved, "Codex").primaryTitle == "检测连接")
        let auto = Wire.object([
            "providerId": .string("commandcode"), "supported": .bool(true),
            "credentialReaders": .array([
                .object(["id": .string("commandcode"), "kind": .string("pi"), "implemented": .bool(true), "owner": .string("external"), "purposes": .array([.string("primary")]), "credentialKinds": .array([.string("api-key")])]),
                .object(["id": .string("commandcode-subsbar-key"), "kind": .string("keychain"), "implemented": .bool(true), "owner": .string("subsbar"), "purposes": .array([.string("primary")]), "credentialKinds": .array([.string("api-key")]), "credentialService": .string("SubsBar credential commandcode")])
            ])
        ])
        let autoGuide = guide(auto, "CommandCode")
        try check("auto-discoverable CommandCode shows detect not login", autoGuide.kind == .apiKey && autoGuide.prefersDetect && autoGuide.primaryTitle == "检测连接" && autoGuide.canPasteKey)
        try check("paste-only api-key still asks for a key", keyGuide.primaryTitle == "粘贴 API Key" && !keyGuide.prefersDetect)
        return count
    }
}
