import Foundation
import SubsCore
import Darwin

public enum M1Suite {
    public static func run() throws -> Int {
        var count = 0
        func check(_ name: String, _ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw LocalFailure("FAIL M1: \(name)") }
            count += 1; print("PASS M1 \(name)")
        }
        func json(_ text: String) throws -> Wire { try Wire.parse(Data(text.utf8)) }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixtures = root.appendingPathComponent("test/fixtures/ipc")
        func fixture(_ name: String) throws -> Wire { try Wire.parse(Data(contentsOf: fixtures.appendingPathComponent(name))) }
        let read = try fixture("config-read-synthetic.json")
        let config = try ConfigDocument(read)
        try check("shared config version and CAS revision", config.revision == 4 && config.contentToken == read["contentToken"].text)
        let patches = try fixture("config-write-patch-synthetic.json")
        let patch = patches["valid"].array[0]["input"]["patch"]
        try check("CAS patch is lossless including explicit null", config.submission(patch: patch) == patches["valid"].array[0]["input"])
        try check("v2 config rejected", (try? ConfigDocument(read.setting("config", read["config"].setting("schemaVersion", .number(2))))) == nil)
        try check("v1 optional extension accepted", try ConfigDocument(read.setting("extension", .bool(true))).revision == 4)
        let empty = try fixture("registry-empty-home.json")
        try check("empty home retains manifest reader declarations", !empty["providers"].array.isEmpty && empty["providers"].array.allSatisfy { $0["profiles"].array.isEmpty && !$0["credentialReaders"].array.isEmpty && !$0["enabled"].bool })
        let registry = try fixture("registry-synthetic.json")
        try check("configured and unconfigured registry share declarations", registry["providers"].array.allSatisfy { $0["credentialReaders"].isArray && $0["dataSources"].isArray })
        for entry in empty["providers"].array {
            try check("\(entry["providerId"].text) source declarations drive UI", entry["credentialReaders"].array.allSatisfy { $0["configurable"].isArray && $0["purposes"].isArray && $0["kind"].string != nil })
        }
        for text in [#"{"a":1,"a":2}"#, #"{"a":1,"\u0061":2}"#, "{} {}", "[]x", "NaN", "1e999", "9007199254740992", "{\"a\":true,}"] {
            try check("strict JSON rejects malformed or ambiguous wire", (try? json(text)) == nil)
        }
        try check("depth limited", (try? json(String(repeating: "[", count: 40) + "0" + String(repeating: "]", count: 40))) == nil)
        try check("size limited", (try? Wire.parse(Data(repeating: 32, count: 1_048_577))) == nil)
        try check("UTF8 strict", (try? Wire.parse(Data([0xff]))) == nil)
        let base = try json(#"{"id":"primary","ruleId":"synthetic-quota","label":"合成额度","kind":"quota","unit":"count","state":"known","quotaState":"within-limit","used":20,"limit":100,"scope":"subscription","provenance":"reported","sourceEndpointIds":[],"diagnostics":[],"derivations":[],"period":{"kind":"rolling","resetState":"unknown"}}"#)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func provider(_ metric: Wire, captured: Double = 1_800_000_000_000) -> Wire {
            .object(["providerId": .string("synthetic"), "profileId": .string("personal"), "scopeKey": .string("scope-synthetic"), "status": .string("ok"), "dataDisposition": .string("current"), "source": .object(["dataSourceId": .string("synthetic-source")]), "lastSuccessAtMs": .number(1_800_000_000_000), "report": .object(["capturedAtMs": .number(captured), "observationBasis": .string("remote-response"), "primaryMetricId": .string("primary"), "windows": .array([metric]), "metrics": .array([]), "diagnostics": .array([])])])
        }
        func envelope(_ rows: [Wire]) -> Wire { .object(["schemaVersion": .number(1), "kind": .string("usage"), "contextId": .string("synthetic-context"), "cacheRevision": .number(1), "generatedAtMs": .number(1_800_000_000_000), "providers": .array(rows), "diagnostics": .array([])]) }
        try check("known metric uses reported quantities", V1Metric(base).usedPercent == 20 && V1Metric(base).fraction == 0.8)
        try check("zero remains known and full", V1Metric(base.setting("used", .number(0))).fraction == 1)
        try check("100 remains known and empty", V1Metric(base.setting("used", .number(100))).fraction == 0)
        try check("zero denominator unknown", V1Metric(base.setting("limit", .number(0))).fraction == nil)
        let over = V1Metric(base.setting("used", .number(150)).setting("quotaState", .string("over-limit")))
        try check("overage retained but drawing clipped", over.usedPercent == 150 && over.fraction == 0 && over.summary.contains("150"))
        var missingFields = base.object; missingFields.removeValue(forKey: "used"); missingFields.removeValue(forKey: "limit")
        let unknown = Wire.object(missingFields).setting("state", .string("unknown")).setting("quotaState", .string("unknown"))
        try check("unknown never fills zero", V1Metric(unknown).valid && V1Metric(unknown).used == nil && V1Metric(unknown).fraction == nil)
        let remaining = unknown.setting("state", .string("remaining-only")).setting("remaining", .number(12.5)).setting("unit", .string("currency")).setting("currency", .string("USD"))
        try check("remaining-only currency", V1Metric(remaining).summary == "剩 USD 12.50" && V1Metric(remaining).fraction == nil)
        for value in [Wire.null, .bool(false), .string("0"), .number(-1), .number(0.5)] {
            try check("count rejects null bool string negative fraction", !V1Metric(base.setting("used", value)).valid)
        }
        try check("unknown enum isolated", !V1Metric(base.setting("unit", .string("new-unit"))).valid)
        try check("unknown optional extension accepted", V1Metric(base.setting("futureExtension", .string("safe"))).valid)
        try check("inconsistent values retain used fraction", V1Metric(base.setting("remaining", .number(90))).inconsistent && V1Metric(base.setting("remaining", .number(90))).fraction == 0.8)
        try check("not started reset explicit", V1Metric(base.setting("period", .object(["kind": .string("rolling"), "resetState": .string("not-started")]))).reset(at: now) == "窗口尚未激活")
        let reset = base.setting("period", .object(["kind": .string("rolling"), "resetState": .string("known"), "resetsAtMs": .number(1_799_999_000_000)]))
        try check("reset elapsed preserves quota", V1Metric(reset).fraction == 0.8 && V1Metric(reset).reset(at: now).contains("等待更新"))
        for (age, expected) in [(600000.0, "fresh"), (600001, "stale"), (86400000, "expired"), (-300001, "invalid")] {
            let row = V1Provider(provider(base, captured: 1_800_000_000_000 - age))
            try check("freshness boundary \(Int(age))", row.freshness(at: now) == expected)
            if ["expired", "invalid"].contains(expected) { try check("old or invalid icon gray", row.iconFraction(at: now) == nil) }
        }
        let legacy = V1Provider(provider(base).setting("dataDisposition", .string("legacy")))
        try check("legacy never active icon", legacy.iconFraction(at: now) == nil)
        let secondaryReport = provider(unknown)["report"].setting("windows", .array([unknown, base.setting("id", .string("secondary"))]))
        try check("primary unknown does not select secondary", V1Provider(provider(unknown).setting("report", secondaryReport)).iconFraction(at: now) == nil)
        try check("duplicate provider isolated", try UsageV1(envelope([provider(base), provider(base)])).providers.first!.invalid)
        try check("v2 usage unsupported", (try? UsageV1(envelope([]).setting("schemaVersion", .number(2)))) == nil)
        let pin = Wire.object(["providerId": .string("synthetic"), "profileId": .string("personal"), "metricId": .string("primary"), "field": .string("remaining-percent"), "style": .string("text")])
        let usage = try UsageV1(envelope([provider(base)]))
        try check("pin exact stable metric", PinnedMetric(pin: pin, usage: usage, enabled: true, now: now).text == "80%")
        try check("disabled pin unknown", PinnedMetric(pin: pin, usage: usage, enabled: false, now: now).text == "—")
        try check("different profile pin cannot leak previous account", PinnedMetric(pin: pin.setting("profileId", .string("other")), usage: usage, enabled: true, now: now).text == "—")
        try check("missing pin no fallback", PinnedMetric(pin: pin.setting("metricId", .string("missing")), usage: usage, enabled: true, now: now).text == "—")
        let receipts = try fixture("refresh-receipt-synthetic.json")
        try check("partial receipt not success", try UsageV1(envelope([]).setting("request", receipts["partial"])).receiptText == "本次部分更新")
        try check("unsaved receipt explicit", try UsageV1(envelope([]).setting("request", receipts["unchanged"])).receiptText!.contains("未写入缓存"))
        try check("busy receipt kept", try UsageV1(envelope([]).setting("request", receipts["deferred-busy"])).receiptText!.contains("等待"))
        let blocked = provider(base).setting("attempt", .object(["state": .string("deferred"), "deferredReason": .string("backoff")])).setting("nextEligibleAtMs", .number(1_800_000_060_001))
        let blockedRequest = Wire.object(["outcome": .string("deferred"), "requestedProviderIds": .strings(["synthetic"]), "cachePersisted": .bool(true)])
        func notice(_ rows: [Wire], request: Wire? = nil, enabled: [String] = ["synthetic"], at: Date? = nil) throws -> String? {
            try UsageV1(envelope(rows).setting("request", request ?? blockedRequest)).backoffNotice(at: at ?? now, enabledIDs: enabled)
        }
        try check("full backoff has visible deadline", try notice([blocked])?.contains("最早") == true)
        try check("backoff expiry invites manual retry", try notice([blocked], at: now.addingTimeInterval(61)) == "退避等待已结束，可点击刷新重试")
        try check("backoff missing deadline stays honest", try notice([blocked.setting("nextEligibleAtMs", .null)])?.contains("未知") == true)
        try check("busy not mislabeled backoff", try notice([blocked.setting("attempt", .object(["state": .string("deferred"), "deferredReason": .string("busy")]))]) == nil)
        for reason in ["not-due", "batch-budget"] {
            try check("\(reason) is not a full backoff notice", try notice([blocked.setting("attempt", .object(["state": .string("deferred"), "deferredReason": .string(reason)]))]) == nil)
        }
        try check("successful request clears backoff notice", try notice([blocked], request: blockedRequest.setting("outcome", .string("updated"))) == nil)
        try check("missing target not called fully blocked", try notice([blocked], request: blockedRequest.setting("requestedProviderIds", .strings(["synthetic", "missing"])), enabled: ["synthetic", "missing"]) == nil)
        try check("disabled targets excluded from backoff", try notice([blocked], enabled: []) == nil)
        try check("mixed success not called fully blocked", try notice([blocked, provider(base).setting("providerId", .string("other"))], request: blockedRequest.setting("requestedProviderIds", .strings(["synthetic", "other"])), enabled: ["synthetic", "other"]) == nil)
        try check("server deadline survives local expiry", try notice([blocked.setting("nextEligibleAtMs", .number(1_799_999_999_000)).setting("error", .object(["retryAtMs": .number(1_800_007_200_000)]))])?.contains("最早") == true)
        let errors = try fixture("error-envelope-synthetic.json")
        try check("CAS conflict actionable", Presentation.error(errors["config-conflict"]["error"]["code"].text).contains("草稿"))
        try check("unknown unsafe error never echoed", !Presentation.error("Bearer synthetic@example.invalid /tmp/secret").contains("Bearer"))
        let vectors = try fixture("usage-golden-vectors.json")
        let normalized = try fixture("usage-golden-normalized.json")
        try check("golden normalized fixed clock matches", normalized["nowMs"] == vectors["nowMs"])
        for vector in vectors["vectors"].array {
            let id = vector["id"].text, output = normalized["vectors"][vector["id"].text]["output"]
            try check("golden \(id) has Node output", output.isObject)
            if output["kind"].text == "quota" {
                let metric = V1Metric(output)
                try check("golden \(id) metric accepted", metric.valid)
                try check("golden \(id) used percentage agrees", metric.usedPercent == output["usedPercent"].number)
                try check("golden \(id) icon agrees", metric.fraction == output["iconFraction"].number)
            } else if id == "primary-unknown" {
                try check("golden primary remains unknown", V1Metric(output["primary"]).fraction == nil && V1Metric(output["secondary"]).fraction == output["secondary"]["iconFraction"].number)
            } else if id == "partial-balance" {
                try check("golden balance retained", V1Metric(output["metrics"].array[0]).summary == "USD 42.00")
            } else if id == "legacy-commandcode" {
                try check("golden legacy balance not percentage", V1Metric(output["metric"]).valid && V1Metric(output["metric"]).fraction == nil)
            } else if output["computedFreshness"].string != nil {
                let timestamp = output["capturedAtMs"].number ?? 1_800_000_000_000 - (output["capturedAgeMs"].number ?? 0)
                try check("golden \(id) freshness agrees", V1Provider(provider(base, captured: timestamp)).freshness(at: now) == output["computedFreshness"].text)
            } else if id == "stale-network" {
                try check("golden stale failure kept visible", V1Provider(provider(base).setting("status", output["status"]).setting("error", output["error"])).issue == Presentation.error("network"))
            } else if id == "scope-switched" {
                let switched = try UsageV1(envelope([provider(base).setting("scopeKey", output["newScopeKey"])]))
                try check("golden scope replacement never merges", switched.providers[0].scope == output["newScopeKey"].text && !switched.providers.contains { $0.scope == output["oldScopeKey"].text })
            }
        }
        count += try bridgeChecks(fixtures: fixtures, config: config)
        count += try liveCLIChecks(root: root, fixture: read)
        return count
    }

    private static func liveCLIChecks(root: URL, fixture: Wire) throws -> Int {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("subsbar-live-ipc-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let configPath = temporary.appendingPathComponent("config.json")
        try fixture["config"].encoded().write(to: configPath)
        let environment = ["HOME": temporary.path, "XDG_CONFIG_HOME": temporary.appendingPathComponent("config").path,
                           "XDG_CACHE_HOME": temporary.appendingPathComponent("cache").path, "XDG_STATE_HOME": temporary.appendingPathComponent("state").path,
                           "PATH": "/usr/bin:/bin"]
        let node = try NodeLocator.locate(explicit: nil, cancellation: Cancellation())
        let bridge = NodeBridge(node: node, root: root, configPath: configPath.path, environment: environment)
        var count = 0
        func check(_ name: String, _ value: Bool) throws {
            guard value else { throw LocalFailure("FAIL M1 live CLI: \(name)") }
            count += 1; print("PASS M1 live CLI \(name)")
        }
        let read = try bridge.call(["config", "read", "--json"])
        let document = try ConfigDocument(read.value)
        try check("shared config parsed from real Node", read.exitCode == 0 && document.revision == fixture["revision"].number)
        let patch = Wire.object(["ui": .object(["density": .string("comfortable"), "selectedProvider": .null])])
        let submission = document.submission(patch: patch)
        let written = try bridge.call(["config", "set", "--stdin"], input: submission)
        try check("CAS write and null clear accepted", written.exitCode == 0 && written.value["kind"].text == "config-write" && written.value["revision"].number == document.revision + 1)
        let conflict = try bridge.call(["config", "set", "--stdin"], input: submission)
        try check("old revision conflicts", conflict.exitCode == 2 && conflict.errorCode == "config-conflict")
        let fresh = try ConfigDocument(bridge.call(["config", "read", "--json"]).value)
        try check("null selection persisted", fresh.config["ui"]["selectedProvider"] == .null)
        let external = fresh.config.setting("ui", fresh.config["ui"].setting("density", .string("compact")))
        try external.encoded().write(to: configPath)
        let changed = try bridge.call(["config", "set", "--stdin"], input: fresh.submission(patch: .object(["ui": .object(["appearance": .string("dark")])])))
        try check("same revision external edit conflicts", changed.exitCode == 2 && changed.errorCode == "config-conflict")
        let after = try ConfigDocument(bridge.call(["config", "read", "--json"]).value)
        try check("conflict preserves external config", after.config["ui"]["density"].text == "compact" && after.revision == fresh.revision)
        let emptyPath = temporary.appendingPathComponent("absent.json")
        let emptyBridge = NodeBridge(node: node, root: root, configPath: emptyPath.path, environment: environment)
        let registry = try emptyBridge.call(["registry", "--json"])
        try check("empty HOME registry contains 14 provider declarations", registry.exitCode == 0 && registry.value["providers"].array.count == 14 && registry.value["providers"].array.allSatisfy { $0["credentialReaders"].isArray && $0["profiles"].array.isEmpty && !$0["enabled"].bool })
        for id in ["copilot", "zai", "openrouter"] {
            let row = registry.value["providers"].array.first { $0["providerId"].text == id } ?? .null
            try check("M2B registry lists \(id)", row["supported"].bool && !row["name"].text.isEmpty)
            let sections = ProviderSections(registry: registry.value["providers"].array, config: .null)
            try check("M2B add subscription includes \(id)", sections.available.contains(id))
            let segment = MenuBarSegment(providerID: id, name: row["name"].text, provider: nil, now: Date())
            try check("M2B short icon name \(id)", !segment.name.isEmpty && segment.name.count <= 3)
            try check("M2B release guide \(id)", ProviderConnectionPresentation.note(id) != nil)
            for source in row["dataSources"].array {
                let draft = Wire.object(["dataSource": source["id"]])
                try check("M2B source admission \(source["id"].text)", (ProviderConnectionPresentation.unavailable(manifest: row, draft: draft) == nil) == (source["admission"].text == "approved"))
            }
            let pendingOnly = row.setting("dataSources", .array([.object(["id": .string("synthetic-pending"), "admission": .string("pending")])]))
            try check("M2B auto pending cannot connect \(id)", ProviderConnectionPresentation.unavailable(manifest: pendingOnly, draft: .null) != nil)
            if id == "zai" {
                let guide = ConnectionGuide(manifest: row, name: row["name"].text)
                let regional = Wire.object(["profiles": .array([.object(["id": .string("synthetic"), "region": .string("cn")])])])
                let prepared = try CredentialWriter.connectionDraft(regional, guide: guide, profileID: "synthetic")
                try check("M2B key save preserves selected region", prepared["profiles"].array.first?["region"].text == "cn")
            }
            let blockedReader = row.setting("credentialReaders", .array([.object(["id": .string("synthetic-reader"), "implemented": .bool(false)])]))
            let explicit = Wire.object(["activeProfile": .string("synthetic"), "profiles": .array([.object(["id": .string("synthetic"), "sources": .array([.object(["reader": .string("synthetic-reader")])])])])])
            try check("M2B unsupported reader blocks \(id)", ProviderConnectionPresentation.unavailable(manifest: blockedReader, draft: explicit) != nil)
        }
        for id in ["antigravity", "devin", "grok", "ollama"] {
            let row = registry.value["providers"].array.first { $0["providerId"].text == id } ?? .null
            try check("M2C pending registry \(id)", !row["name"].text.isEmpty && ProviderConnectionPresentation.awaitingAdmission(row))
            try check("M2C add list retains \(id)", ProviderSections(registry: registry.value["providers"].array, config: .null).available.contains(id))
            let segment = MenuBarSegment(providerID: id, name: row["name"].text, provider: nil, now: Date())
            try check("M2C short name \(id)", !segment.name.isEmpty && segment.name.count <= 3)
            let guide = ConnectionGuide(manifest: row, name: row["name"].text)
            try check("M2C no login or paste action \(id)", guide.kind == .unsupported && !guide.canPasteKey && guide.command == nil && !guide.prefersDetect)
            try check("M2C auto blocked \(id)", ProviderConnectionPresentation.unavailable(manifest: row, draft: .null) != nil)
            try check("M2C release guidance \(id)", ProviderConnectionPresentation.note(id)?.contains("待启用") == true)
            for source in row["dataSources"].array {
                try check("M2C explicit pending blocked \(source["id"].text)", ProviderConnectionPresentation.unavailable(manifest: row, draft: .object(["dataSource": source["id"]])) != nil)
            }
        }
        let claude = registry.value["providers"].array.first { $0["providerId"].text == "claude" } ?? .null
        try check("Claude registry blocked remains visible", claude["releaseStatus"].text == "blocked" && ProviderSections(registry: registry.value["providers"].array, config: .null).available.contains("claude"))
        try check("Claude live blocked not pending", ProviderConnectionPresentation.blockedReason(claude) != nil && !ProviderConnectionPresentation.awaitingAdmission(claude))
        let claudeGuide = ConnectionGuide(manifest: claude, name: "Claude")
        try check("Claude live registry no connect action", claudeGuide.kind == .unsupported && !claudeGuide.canPasteKey && claudeGuide.command == nil && !claudeGuide.prefersDetect)
        let usage = try UsageV1(emptyBridge.call(["usage", "--json"]).value)
        try check("empty HOME usage disables all providers", usage.providers.count == 14 && usage.providers.allSatisfy { $0.status == "disabled" && !$0.report.isObject })
        let unknown = try emptyBridge.call(["registry", "--json", "--provider", "synthetic-unknown"])
        try check("unregistered provider rejected", unknown.exitCode == 2 && unknown.errorCode != nil)
        let absent = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
        try check("absent file has Node default revision and token", absent.revision == 0 && absent.contentToken == "absent" && !FileManager.default.fileExists(atPath: emptyPath.path))
        let firstInput = absent.submission(patch: .object(["ui": .object(["density": .string("comfortable")])]))
        let firstWrite = try emptyBridge.call(["config", "set", "--stdin"], input: firstInput)
        try check("absent CAS initializes config", firstWrite.exitCode == 0 && firstWrite.value["revision"].number == 1)
        let raced = try emptyBridge.call(["config", "set", "--stdin"], input: firstInput)
        try check("second absent CAS conflicts", raced.exitCode == 2 && raced.errorCode == "config-conflict")
        let noOp = try emptyBridge.call(["refresh", "--json", "--reason", "manual", "--interaction", "background"])
        try check("all disabled refresh is no-op", noOp.exitCode == 0 && noOp.value["request"]["outcome"].text == "no-op")
        let keyManifest = registry.value["providers"].array.first { $0["providerId"].text == "kimi" } ?? .null
        let keyGuide = ConnectionGuide(manifest: keyManifest, name: "Kimi")
        try check("registry supplies final keychain destination", keyGuide.credentialService == "SubsBar credential kimi" && keyGuide.canPasteKey)
        let keyDraft = try CredentialWriter.connectionDraft(.object(["dataSource": .string("auto"), "allowCommunityEndpoints": .bool(false), "profiles": .array([])]), guide: keyGuide, profileID: "synthetic-connection")
        let keyBase = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
        let keyConfig = try emptyBridge.call(["config", "set", "--stdin"], input: keyBase.submission(patch: .object(["providers": .object(["kimi": keyDraft])])) )
        try check("GUI key reference passes Node schema and CAS", keyConfig.exitCode == 0 && keyConfig.value["kind"].text == "config-write")
        let keyRead = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
        try check("GUI profile reference persisted without secret", keyRead.config["providers"]["kimi"]["profiles"].array[0]["sources"].array[0]["account"].text == "kimi:synthetic-connection")

        // Synthetic cache input only; projection is performed exclusively by the real Node CLI.
        let cacheURL = temporary.appendingPathComponent("cache/subsbar/usage-v1.json")
        try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let row = try Wire.parse(Data(#"{"providerId":"commandcode","profileId":"personal","configRevision":4,"scopeKey":"scope-synthetic","accountKey":"account-synthetic","status":"ok","freshness":"fresh","dataDisposition":"current","source":{"dataSourceId":"commandcode-alpha"},"report":{"windows":[],"metrics":[]},"diagnostics":[]}"#.utf8))
        let cached = Wire.object(["schemaVersion": .number(1), "kind": .string("usage"), "contextId": .string("synthetic"), "cacheRevision": .number(1), "providers": .array([row])])
        try cached.encoded().write(to: cacheURL)
        let matched = try bridge.call(["usage", "--json"]).value["providers"].array[0]
        try check("matching profile retains report", matched["report"].isObject && matched["scopeKey"].text == "scope-synthetic")
        let disable = after.submission(patch: .object(["providers": .object(["commandcode": .object(["enabled": .bool(false)])])]))
        let disabledWrite = try bridge.call(["config", "set", "--stdin"], input: disable)
        try check("disable invalidates provider", disabledWrite.exitCode == 0 && disabledWrite.value["invalidatedProviderIds"].array.contains(.string("commandcode")))
        let disabled = try bridge.call(["usage", "--json"]).value["providers"].array[0]
        try check("disabled projection removes account data", disabled["status"].text == "disabled" && !disabled["report"].isObject && disabled["scopeKey"].string == nil && disabled["source"].isObject == false && disabled["accountKey"].string == nil)
        let disabledConfig = try ConfigDocument(bridge.call(["config", "read", "--json"]).value)
        let reenabled = try bridge.call(["config", "set", "--stdin"], input: disabledConfig.submission(patch: .object(["providers": .object(["commandcode": .object(["enabled": .bool(true)])])])) )
        try check("reenable CAS succeeds", reenabled.exitCode == 0)
        let invalidated = try bridge.call(["usage", "--json"]).value["providers"].array[0]
        try check("invalidated report stays hidden after reenable", invalidated["status"].text == "not-configured" && !invalidated["report"].isObject && invalidated["diagnostics"].array.contains { $0["code"].text == "stale-foreign" })
        try cached.setting("providers", .array([row.setting("profileId", .string("other")).setting("configRevision", .number(999))])).encoded().write(to: cacheURL)
        let foreign = try bridge.call(["usage", "--json"]).value["providers"].array[0]
        try check("foreign profile strips report even at newer revision", foreign["profileId"].text == "personal" && foreign["status"].text == "not-configured" && !foreign["report"].isObject && foreign["scopeKey"].string == nil)
        let menuIDs = ["codex", "kimi", "commandcode", "cursor"]
        for n in [0, 1, 2, 4] {
            let base = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
            let input = base.submission(patch: .object(["ui": .object(["menuBarProviders": .strings(Array(menuIDs.prefix(n))), "menuBarLimit": .number(Double(n))])]))
            let result = try emptyBridge.call(["config", "set", "--stdin"], input: input)
            let stored = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
            try check("menu CAS \(n) providers", result.exitCode == 0 && stored.config["ui"]["menuBarProviders"].array.map(\.text) == Array(menuIDs.prefix(n)) && stored.config["ui"]["menuBarLimit"].number == Double(n))
            let conflict = try emptyBridge.call(["config", "set", "--stdin"], input: input)
            try check("menu CAS \(n) conflict", conflict.exitCode == 2 && conflict.errorCode == "config-conflict")
        }
        let menuBase = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
        let rejectedMenu = try emptyBridge.call(["config", "set", "--stdin"], input: menuBase.submission(patch: .object(["ui": .object(["menuBarProviders": .strings(menuIDs), "menuBarLimit": .number(1)])])))
        try check("menu over limit rejected by Node", rejectedMenu.exitCode == 2)
        let restoredMenu = try emptyBridge.call(["config", "set", "--stdin"], input: menuBase.submission(patch: .object(["ui": .object(["menuBarProviders": .null, "menuBarLimit": .number(1)])])))
        let menuDefault = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
        try check("menu null default restores", restoredMenu.exitCode == 0 && menuDefault.config["ui"]["menuBarProviders"] == .null && menuDefault.config["ui"]["menuBarLimit"].number == 1)
        try check("menu legacy switches not emitted", menuDefault.config["ui"].object["pinnedMetrics"] == nil && menuDefault.config["ui"].object["menuBarMode"] == nil)
        // Exercise the very same edits used by the settings checkboxes, through real Node CAS.
        let editIDs = ["codex", "kimi", "droid", "cursor", "commandcode"]
        func menuEdit(_ name: String, expected: [String], edit: (Wire) -> Wire) throws {
            let before = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
            let changed = edit(before.config["ui"])
            let written = try emptyBridge.call(["config", "set", "--stdin"], input: before.submission(patch: .object(["ui": changed])))
            let after = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
            let visible = MenuBarSelection.visible(ui: after.config["ui"], ordered: editIDs, enabled: editIDs)
            try check("checkbox CAS \(name)", written.exitCode == 0 && visible == expected && (after.config["ui"]["menuBarLimit"].number ?? 0) >= Double(expected.count))
        }
        try menuEdit("default 1", expected: ["codex"]) { MenuBarEditing.defaults($0) }
        for (index, id) in editIDs.prefix(4).enumerated() {
            try menuEdit("select \(index + 1)", expected: Array(editIDs.prefix(index + 1))) { MenuBarEditing.toggle(id, on: true, ui: $0, ordered: editIDs, enabled: editIDs) }
        }
        try menuEdit("fifth blocked", expected: Array(editIDs.prefix(4))) { MenuBarEditing.toggle("commandcode", on: true, ui: $0, ordered: editIDs, enabled: editIDs) }
        try menuEdit("uncheck", expected: ["codex", "droid", "cursor"]) { MenuBarEditing.toggle("kimi", on: false, ui: $0, ordered: editIDs, enabled: editIDs) }
        try menuEdit("recheck", expected: Array(editIDs.prefix(4))) { MenuBarEditing.toggle("kimi", on: true, ui: $0, ordered: editIDs, enabled: editIDs) }
        try menuEdit("limit zero", expected: []) { MenuBarEditing.limit(0, ui: $0, ordered: editIDs, enabled: editIDs) }
        try menuEdit("select from zero", expected: ["kimi"]) { MenuBarEditing.toggle("kimi", on: true, ui: $0, ordered: editIDs, enabled: editIDs) }
        try menuEdit("uncheck last", expected: []) { MenuBarEditing.toggle("kimi", on: false, ui: $0, ordered: editIDs, enabled: editIDs) }
        try menuEdit("restore default", expected: ["codex"]) { MenuBarEditing.defaults($0) }
        let focusBase = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
        let focusWrite = try emptyBridge.call(["config", "set", "--stdin"], input: focusBase.submission(patch: .object(["ui": ProviderNavigation.focus("kimi")])))
        let focused = try ConfigDocument(emptyBridge.call(["config", "read", "--json"]).value)
        try check("direct selector CAS focuses clicked provider", focusWrite.exitCode == 0 && ProviderNavigation.selected("kimi", ui: focused.config["ui"]) && !ProviderNavigation.selected("codex", ui: focused.config["ui"]))
        try check("selector six wraps into two rows", ProviderNavigation.rows(Array(0..<6), width: 340).map(\.count) == [4, 2])
        try check("selector fourteen wraps into four rows", ProviderNavigation.rows(Array(0..<14), width: 340).map(\.count) == [4, 4, 4, 2])
        try check("selector preserves every direct target", ProviderNavigation.rows(Array(0..<14), width: 340).flatMap { $0 } == Array(0..<14))
        try check("selector hidden in overview", !ProviderNavigation.visible(ui: .object(["overviewMode": .string("cards")])))
        try check("selector visible in single mode", ProviderNavigation.visible(ui: focused.config["ui"]))
        try check("selector narrow width retains all targets", ProviderNavigation.rows(Array(0..<6), width: 78).map(\.count) == [1, 1, 1, 1, 1, 1])
        try check("selector rows fit available width", Double(ProviderNavigation.columns(width: 340)) * ProviderNavigation.chipWidth + Double(ProviderNavigation.columns(width: 340) - 1) * ProviderNavigation.spacing <= 340)
        try check("zero limit auto has no checked provider", MenuBarSelection.selected(ui: .object(["menuBarLimit": .number(0)]), ordered: editIDs, enabled: editIDs).isEmpty)
        try check("selector short row fits", ProviderNavigation.rows(Array(0..<3), width: 340).count == 1)
        try check("overview has no selected chip", !ProviderNavigation.selected("kimi", ui: focused.config["ui"].setting("overviewMode", .string("cards"))))
        let legacyURL = temporary.appendingPathComponent("legacy-menu.json")
        let legacyBridge = NodeBridge(node: node, root: root, configPath: legacyURL.path, environment: environment)
        for ids in [["commandcode", "codex"], ["codex", "codex"], []] {
            var ui = fixture["config"]["ui"].object
            ui.removeValue(forKey: "menuBarProviders"); ui.removeValue(forKey: "menuBarLimit")
            ui["menuBarMode"] = .string("pinned")
            ui["pinnedMetrics"] = .array(ids.map { .object(["providerId": .string($0), "profileId": .string("personal"), "metricId": .string("synthetic-primary"), "field": .string("remaining-percent"), "style": .string("text")]) })
            try fixture["config"].setting("ui", .object(ui)).encoded().write(to: legacyURL)
            let migrated = try ConfigDocument(legacyBridge.call(["config", "read", "--json"]).value)
            var unique: [String] = []; for id in ids where !unique.contains(id) { unique.append(id) }
            try check("menu legacy migration \(ids)", migrated.config["ui"]["menuBarProviders"].array.map(\.text) == unique && migrated.config["ui"]["menuBarLimit"].number == Double(ids.isEmpty ? 1 : min(ids.count, 4)))
            let saved = try legacyBridge.call(["config", "set", "--stdin"], input: migrated.submission(patch: .object(["ui": .object(["menuBarProviders": migrated.config["ui"]["menuBarProviders"], "menuBarLimit": migrated.config["ui"]["menuBarLimit"]])])))
            let disk = try Wire.parse(Data(contentsOf: legacyURL))
            try check("menu legacy write strips fields \(ids)", saved.exitCode == 0 && disk["ui"].object["pinnedMetrics"] == nil && disk["ui"].object["menuBarMode"] == nil)
        }

        // Rev8 integration through the real CLI; missing synthetic source prevents any network request.
        let retryPath = temporary.appendingPathComponent("retry-config.json")
        let retryBridge = NodeBridge(node: node, root: root, configPath: retryPath.path, environment: environment)
        let retryBase = try ConfigDocument(retryBridge.call(["config", "read", "--json"]).value)
        let retrySource = Wire.object(["id": .string("missing"), "kind": .string("env"), "reader": .string("kimi-env-key"), "purpose": .string("primary"), "envName": .string("SUBSBAR_SYNTHETIC_ABSENT")])
        let retryProfile = Wire.object(["id": .string("synthetic"), "discovery": .string("only"), "sources": .array([retrySource])])
        let retryProvider = Wire.object(["enabled": .bool(true), "allowCommunityEndpoints": .bool(true), "activeProfile": .string("synthetic"), "profiles": .array([retryProfile])])
        let retryWrite = try retryBridge.call(["config", "set", "--stdin"], input: retryBase.submission(patch: .object(["providers": .object(["kimi": retryProvider])])))
        try check("retry integration synthetic config CAS", retryWrite.exitCode == 0)
        let retryState = temporary.appendingPathComponent("state/subsbar/runtime-v1.json")
        let retryCache = temporary.appendingPathComponent("cache/subsbar/usage-v1.json")
        let stamp = floor(Date().timeIntervalSince1970 * 1000)
        func seededRefresh(_ state: Wire, reason: String) throws -> UsageV1 {
            try? FileManager.default.removeItem(at: retryCache)
            try Wire.object(["providers": .object(["kimi": state])]).encoded().write(to: retryState)
            return try UsageV1(retryBridge.call(["refresh", "--json", "--reason", reason]).value)
        }
        let localRetry = Wire.object(["lastAttemptAtMs": .number(stamp - 60_000), "consecutiveFailures": .number(2), "localBackoffAtMs": .number(stamp + 600_000.5), "nextEligibleAtMs": .number(stamp + 600_000.5)])
        let timerDeferred = try seededRefresh(localRetry, reason: "timer")
        try check("timer respects fractional legacy local backoff and Swift displays deadline", timerDeferred.backoffNotice(at: Date(), enabledIDs: ["kimi"]) != nil && timerDeferred.providers.first(where: { $0.id == "kimi" })?.raw["nextEligibleAtMs"].number == stamp + 600_001)
        let manualRetry = try seededRefresh(localRetry, reason: "manual")
        try check("manual bypasses local backoff and disabled rows do not mask failure", manualRetry.raw["request"]["outcome"].text == "failed" && manualRetry.providers.first(where: { $0.id == "kimi" })?.raw["attempt"]["state"].text == "failed" && manualRetry.backoffNotice(at: Date(), enabledIDs: ["kimi"]) == nil)
        let serverDeferred = try seededRefresh(localRetry.setting("serverRetryAtMs", .number(stamp + 7_200_000)), reason: "manual")
        try check("manual retains server Retry-After and native notice", serverDeferred.backoffNotice(at: Date(), enabledIDs: ["kimi"]) != nil && serverDeferred.providers.first(where: { $0.id == "kimi" })?.raw["nextEligibleAtMs"].number == stamp + 7_200_000)
        let rapid = try seededRefresh(localRetry.setting("lastAttemptAtMs", .number(floor(Date().timeIntervalSince1970 * 1000))), reason: "manual")
        try check("manual 30s floor stays not-due not backoff", rapid.providers.first(where: { $0.id == "kimi" })?.raw["attempt"]["deferredReason"].text == "not-due" && rapid.backoffNotice(at: Date(), enabledIDs: ["kimi"]) == nil)

        return count
    }

    private static func bridgeChecks(fixtures: URL, config: ConfigDocument) throws -> Int {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("subsbar-m1-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary.appendingPathComponent("core"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let script = #"""
        import fs from 'node:fs';
        const arg = process.argv[2];
        const fixture = name => JSON.parse(fs.readFileSync(process.env.FIXTURES + '/' + name));
        const out = (data, code=0) => { process.stdout.write(JSON.stringify(data)+'\n'); process.exitCode=code; };
        if (arg === 'config') {
          if (process.argv[3] === 'read') out(fixture('config-read-synthetic.json'));
          else { let text=''; for await (const chunk of process.stdin) text+=chunk;
            const actual=JSON.parse(text), expected=fixture('config-write-patch-synthetic.json').valid[0].input;
            if(actual.baseRevision!==expected.baseRevision || actual.contentToken!==expected.contentToken || actual.patch.ui.selectedProvider!==null) process.exit(9);
            out(fixture('error-envelope-synthetic.json')['config-conflict'],2);
          }
        } else if(arg === 'cancel') {
          process.on('SIGTERM',()=>{ out({schemaVersion:1,kind:'usage',request:fixture('refresh-receipt-synthetic.json').cancelled},3); process.exit(3); });
          fs.writeFileSync('cancel-ready', 'ready');
          setInterval(()=>{},50);
        } else if(arg === 'hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},50); }
        else if(arg === 'big') process.stdout.write(' '.repeat(1048577));
        else if(arg === 'duplicate') process.stdout.write('{"schemaVersion":1,"kind":"error","kind":"usage"}\n');
        """#
        try Data(script.utf8).write(to: temporary.appendingPathComponent("core/cli.mjs"))
        let node = try NodeLocator.locate(explicit: nil, cancellation: Cancellation())
        let bridge = NodeBridge(node: node, root: temporary, environment: ["FIXTURES": fixtures.path, "PATH": "/usr/bin:/bin"])
        var count = 0
        func check(_ name: String, _ value: Bool) throws { guard value else { throw LocalFailure("FAIL M1 bridge: \(name)") }; count += 1; print("PASS M1 bridge \(name)") }
        let response = try bridge.call(["config", "read", "--json"])
        try check("shared config over real pipe", try ConfigDocument(response.value).contentToken == config.contentToken)
        let patch = Wire.object(["ui": .object(["density": .string("comfortable"), "selectedProvider": .null])])
        let conflict = try bridge.call(["config", "set", "--stdin"], input: config.submission(patch: patch))
        try check("stdin CAS conflict exit 2 parsed", conflict.exitCode == 2 && conflict.errorCode == "config-conflict")
        try check("bounded output", (try? bridge.call(["big"])) == nil)
        try check("duplicate keys rejected", (try? bridge.call(["duplicate"])) == nil)
        let token = Cancellation()
        // Cancel only once the fixture has installed SIGTERM handling. Slow CI
        // process startup must not turn this graceful-receipt test into early cancellation.
        let ready = temporary.appendingPathComponent("cancel-ready")
        DispatchQueue.global().async {
            let deadline = ProcessInfo.processInfo.systemUptime + 10
            while !FileManager.default.fileExists(atPath: ready.path), ProcessInfo.processInfo.systemUptime < deadline {
                Thread.sleep(forTimeInterval: 0.01)
            }
            token.cancel()
        }
        let cancelled = try bridge.call(["cancel"], timeout: 12, cancellation: token)
        try check("SIGTERM retains cancelled receipt", cancelled.exitCode == 3 && cancelled.value["request"]["outcome"].text == "cancelled")
        let started = ProcessInfo.processInfo.systemUptime
        try check("timeout terminates owned child", (try? bridge.call(["hang"], timeout: 0.15)) == nil)
        try check("SIGKILL fallback bounded", ProcessInfo.processInfo.systemUptime - started < 2)
        return count
    }
}
