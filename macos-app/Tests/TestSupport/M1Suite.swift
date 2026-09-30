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
        let errors = try fixture("error-envelope-synthetic.json")
        try check("CAS conflict actionable", Presentation.error(errors["config-conflict"]["error"]["code"].text).contains("草稿"))
        try check("unknown unsafe error never echoed", !Presentation.error("Bearer synthetic@example.invalid /tmp/secret").contains("Bearer"))
        count += try bridgeChecks(fixtures: fixtures, config: config)
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
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) { token.cancel() }
        let cancelled = try bridge.call(["cancel"], cancellation: token)
        try check("SIGTERM retains cancelled receipt", cancelled.exitCode == 3 && cancelled.value["request"]["outcome"].text == "cancelled")
        let started = ProcessInfo.processInfo.systemUptime
        try check("timeout terminates owned child", (try? bridge.call(["hang"], timeout: 0.15)) == nil)
        try check("SIGKILL fallback bounded", ProcessInfo.processInfo.systemUptime - started < 2)
        return count
    }
}
