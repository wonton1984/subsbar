import Foundation
import SubsCore
import Darwin

public enum Suite {
    public static func run() throws -> Int {
        var count = 0
        func check(_ name: String, _ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw LocalFailure("FAIL: \(name)") }
            count += 1; print("PASS \(name)")
        }
        func decode(_ text: String) throws -> [String: Entry] { try Cache.parse(Data(text.utf8)) }
        func rejects(_ text: String) -> Bool { (try? decode(text)) == nil }
        let now = Date(timeIntervalSince1970: 1_950_681_800)
        let normal = try decode(#"{"kimi":{"fetchedAt":1950681768254,"report":{"capturedAt":1950681768552,"windows":[{"id":"5h","label":"5h窗口","used":93,"remaining":7,"limit":100,"resetsAt":1950682915,"primary":true},{"label":"周配额","used":68,"limit":100}],"metrics":[{"label":"Credits","value":"无"},{"label":"消费","value":12.5,"unit":"usd"}]}},"opencode":{"fetchedAt":1950681768254,"report":{"windows":[{"used":17,"unit":"percent","primary":true},{"used":19,"limit":100}]}}}"#)
        try check("normal Kimi 7%", abs(normal["kimi"]!.fraction! - 0.07) < 0.00001)
        try check("normal OpenCode 83% percent without limit", abs(normal["opencode"]!.fraction! - 0.83) < 0.00001)
        try check("resetsAt seconds", normal["kimi"]!.windows[0].resetsAt!.timeIntervalSince1970 == 1950682915)
        try check("fetchedAt milliseconds", abs(normal["kimi"]!.fetchedAt!.timeIntervalSince1970 - 1950681768.254) < 0.001)
        try check("capturedAt milliseconds", abs(normal["kimi"]!.capturedAt!.timeIntervalSince1970 - 1950681768.552) < 0.001)
        try check("metrics string and number", normal["kimi"]!.metrics.map(\.value) == ["无", "12.5 usd"])
        try check("empty object", try decode("{}").isEmpty)
        for input in ["", "{", "[]", "null", "1"] { try check("reject malformed/root: \(input)", rejects(input)) }
        try check("invalid UTF8", (try? Cache.parse(Data([0xff, 0xfe]))) == nil)
        try check("oversize", (try? Cache.parse(Data(repeating: 32, count: Cache.maxBytes + 1))) == nil)
        let six = try decode(#"{"droid":{"fetchedAt":1950681800000,"report":{"windows":[{"label":"标准额度","used":10300000,"limit":25000000,"unit":"count","primary":true,"resetsAt":null}]}},"cursor":{"fetchedAt":1950681800000,"report":{"windows":[{"label":"总量","used":62.5,"limit":100,"unit":"percent","primary":true}],"metrics":[{"label":"赠送额度","value":150.25,"unit":"usd"}]}}}"#)
        try check("six capabilities enabled", Provider.all.count == 6 && Provider.all.allSatisfy(\.supported))
        try check("Droid synthetic scale", abs(six["droid"]!.fraction! - 0.588) < 0.0000001)
        try check("Droid null endDate gracefully unknown", Cache.countdown(six["droid"]!.windows[0].resetsAt, now: now) == "重置时间未知")
        try check("Cursor 62.5 used means 37.5 remaining", abs(six["cursor"]!.fraction! - 0.375) < 0.000001)
        try check("Cursor bonus USD preserved", six["cursor"]!.metrics[0].value == "150.25 usd")
        try check("absent onDemand adds no fictional rail", six["cursor"]!.windows.count == 1)
        try check("Cursor shared selection accepted", Cache.selection(native: nil, shared: Data(#"{"selected":"cursor"}"#.utf8), entries: six, now: now) == "cursor")
        let droidWindows = try decode(#"{"droid":{"fetchedAt":1950681800000,"report":{"windows":[{"id":"standard","label":"标准额度","used":10300000,"limit":25000000,"unit":"count"},{"id":"five-hour","label":"5小时额度","used":35,"limit":100,"unit":"percent","primary":true,"resetsAt":1950683000},{"id":"weekly","label":"每周额度","used":42,"limit":100,"unit":"percent","resetsAt":1951000000}]}}}"#)
        try check("Droid all time windows preserved", droidWindows["droid"]!.windows.count == 3)
        try check("Droid five-hour primary drives icon", droidWindows["droid"]!.main?.label == "5小时额度" && droidWindows["droid"]!.fraction == 0.65)
        let contract = try decode(#"{"droid":{"report":{"windows":[{"label":"滚动月","used":13,"limit":100,"unit":"percent"},{"label":"滚动周","used":52,"limit":100,"unit":"percent"},{"label":"滚动5h","used":0,"limit":100,"unit":"percent","primary":true,"resetsAt":1950691591},{"label":"标准额度","used":10300000,"limit":25000000}]}},"codex":{"report":{"windows":[{"label":"周主窗口","used":34,"limit":100,"unit":"percent","primary":true,"windowMinutes":10080}]}},"commandcode":{"report":{"windows":[{"label":"月度credits","resetsAt":1950741079},{"label":"滚动5h","used":0,"limit":20,"resetsAt":0},{"label":"周窗口","used":0,"limit":50}]}}}"#)
        try check("Droid zero usage primary survives monthly-first ordering", contract["droid"]!.windows.count == 4 && contract["droid"]!.fraction == 1)
        try check("Droid rolling reset seconds", contract["droid"]!.main?.resetsAt?.timeIntervalSince1970 == 1950691591)
        try check("Codex weekly label preserved", contract["codex"]!.main?.label == "周主窗口")
        try check("CommandCode monthly reset seconds", contract["commandcode"]!.windows[0].resetsAt?.timeIntervalSince1970 == 1950741079)
        try check("Zero and absent reset stay unknown", contract["commandcode"]!.windows.dropFirst().allSatisfy { $0.resetsAt == nil })
        let monthly = try decode(#"{"commandcode":{"report":{"windows":[{"id":"monthly-credits","label":"月度credits","used":48.21,"limit":62.8,"unit":"usd"},{"id":"window-fiveHour","used":0,"limit":14,"primary":true}]}}}"#)["commandcode"]!
        try check("CmdCode actual monthly used and allocation", monthly.windows[0].effectiveUsed == 48.21 && monthly.windows[0].limit == 62.8 && abs(monthly.windows[0].fraction! - (1 - 48.21 / 62.8)) < 0.001)
        try check("CmdCode rolling primary remains independent", monthly.fraction == 1)
        let balance = try decode(#"{"commandcode":{"report":{"windows":[{"id":"monthly-credits","label":"月度credits（剩余）","used":0,"limit":12.34,"unit":"usd","primary":true}]}}}"#)["commandcode"]!
        try check("CmdCode summary-less balance preserves remaining", balance.windows[0].remaining == 12.34)
        try check("CmdCode summary-less balance invents no usage limit or percentage", balance.windows[0].used == nil && balance.windows[0].limit == nil && balance.fraction == nil)
        let remainingOnly = try decode(#"{"commandcode":{"report":{"windows":[{"id":"monthly-credits","label":"月度credits（剩余）","remaining":12.34,"unit":"usd","primary":true}],"notes":["月度口径：summary 不可用，仅显示剩余额度"]}}}"#)["commandcode"]!
        try check("remaining-only balance accepted", remainingOnly.windows[0].remaining == 12.34 && remainingOnly.windows[0].used == nil && remainingOnly.windows[0].limit == nil)
        try check("remaining-only percentage unknown", remainingOnly.fraction == nil && remainingOnly.windows[0].effectiveUsed == nil)
        try check("summary unavailable note retained", remainingOnly.notes.first == "月度口径：summary 不可用，仅显示剩余额度")
        let partial = try decode(#"{"kimi":{"report":{"windows":[null,{"used":true,"limit":0},{"used":"4","limit":"10"}],"metrics":[null,{"label":"Credits","value":"3"}]}},"codex":null,"opencode":{"report":{"metrics":[{"label":"Credits","value":2}]}},"unexpected":{"report":{}}}"#)
        try check("provider isolated", partial["codex"]?.error != nil && partial["kimi"]?.windows.count == 2)
        try check("bad row isolated", partial["kimi"]!.warnings.count >= 2 && partial["kimi"]!.metrics.count == 1)
        try check("primary fallback valid used", partial["kimi"]!.fraction == 0.6)
        try check("metrics-only", partial["opencode"]?.fraction == nil && partial["opencode"]?.metrics.count == 1)
        try check("unknown keys ignored", partial["unexpected"] == nil)
        for (value, band) in [(0.0, Band.red), (0.199, .red), (0.20, .orange), (0.5, .orange), (0.501, .green), (1.0, .green)] { try check("band \(value)", Cache.band(value) == band) }
        try check("unknown band", Cache.band(nil) == .gray)
        let cases: [(String, Double?)] = [
            (#"{"used":200,"limit":100}"#, 0), (#"{"used":0,"limit":0}"#, nil), (#"{"limit":100}"#, nil),
            (#"{"used":false,"limit":100}"#, nil), (#"{"used":-1,"limit":100}"#, nil), (#"{"used":"NaN","limit":100}"#, nil),
            (#"{"used":"20","limit":"100"}"#, 0.8), (#"{"remaining":20,"limit":100}"#, 0.2), (#"{"remaining":200,"limit":100}"#, nil),
            (#"{"used":93,"remaining":99,"limit":100}"#, 0.07)
        ]
        for (i, pair) in cases.enumerated() {
            let entry = try decode("{\"kimi\":{\"report\":{\"windows\":[\(pair.0)]}}}")["kimi"]!
            try check("numeric case \(i)", pair.1 == nil ? entry.fraction == nil : abs(entry.fraction! - pair.1!) < 0.000001)
        }
        let twenty = try decode(#"{"kimi":{"report":{"windows":[{"used":80,"limit":100}]}}}"#)
        try check("computed 20% boundary stays orange", Cache.band(twenty["kimi"]!.fraction) == .orange)
        let primaries = try decode(#"{"kimi":{"report":{"windows":[{"limit":0,"primary":true},{"used":0,"limit":100,"primary":true}]}}}"#)
        try check("first primary not greener fallback", primaries["kimi"]?.fraction == nil)
        let entry = normal["kimi"]!
        let fetched = entry.fetchedAt!
        try check("10m inclusive fresh", entry.freshness(at: fetched.addingTimeInterval(600)) == .fresh)
        try check("10m+ stale", entry.freshness(at: fetched.addingTimeInterval(601)) == .stale)
        try check("24h expired", entry.freshness(at: fetched.addingTimeInterval(86400)) == .expired && entry.iconFraction(at: fetched.addingTimeInterval(86400)) == nil)
        try check("future clock invalid", entry.freshness(at: fetched.addingTimeInterval(-301)) == .invalid)
        try check("reset crossed retains usage", Cache.countdown(entry.windows[0].resetsAt, now: fetched.addingTimeInterval(9000)).contains("等待更新") && entry.windows[0].used == 93)
        try check("native wins shared", Cache.selection(native: "cursor", shared: Data(#"{"selected":"kimi"}"#.utf8), entries: normal, now: now) == "cursor")
        try check("shared first launch", Cache.selection(native: nil, shared: Data(#"{"selected":"kimi"}"#.utf8), entries: normal, now: now) == "kimi")
        try check("unknown shared fallback", Cache.selection(native: "unknown", shared: Data(#"{"selected":"unknown"}"#.utf8), entries: normal, now: now) == "opencode")
        try check("empty selection fallback", Cache.selection(native: nil, shared: Data("{".utf8), entries: [:], now: now) == "codex")
        var before = Snapshot(); before.entries = normal
        var after = Snapshot(); after.entries = try decode(#"{"kimi":{"fetchedAt":1950681800000,"report":{"windows":[{"used":95,"limit":100}]}},"opencode":{"fetchedAt":1950681768254,"report":{"windows":[{"used":17,"limit":100}]}}}"#)
        let outcomes = RefreshContract.outcomes(before: before, after: after, failure: nil, now: now)
        try check("partial update isolated", outcomes["kimi"] == "已更新" && outcomes["opencode"]!.contains("未获得"))
        try check("exit0 unchanged not success", !RefreshContract.outcomes(before: before, after: before, failure: nil, now: now).values.contains("已更新"))
        try check("all failure", RefreshContract.outcomes(before: before, after: before, failure: "测试失败", now: now)["kimi"] == "✗ 测试失败")
        var future = Snapshot(); future.entries = try decode(#"{"kimi":{"fetchedAt":1950691800000,"report":{"windows":[{"used":0,"limit":100}]}}}"#)
        try check("future snapshot cannot block recovery", future.merging(after, now: now).entries["kimi"] == after.entries["kimi"])
        let metricsOnly = try decode(#"{"codex":{"fetchedAt":1950681800000,"report":{"metrics":[{"label":"Credits","value":3}]}}}"#)
        try check("metrics-only valid selection fallback", Cache.selection(native: nil, shared: nil, entries: metricsOnly, now: now) == "codex")
        let merged = after.merging(before, now: now) // 显式传 now：fixture epoch 为合成 2031 段，不依赖真实时钟
        try check("reject cache rollback", merged.entries["kimi"] == after.entries["kimi"] && merged.diagnostics["kimi"] != nil)
        var invalid = Snapshot(); invalid.error = "JSON 无效"
        try check("keep snapshot on read failure", before.merging(invalid).entries == before.entries && before.merging(invalid).error != nil)
        try check("missing entry last-known", before.merging(Snapshot()).diagnostics["kimi"] != nil)
        try check("explicit agent path rejected", (try? DataPaths(environment: ["PI_CODING_AGENT_DIR": "relative"])) == nil)
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent("SubsBar test \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }
        let paths = try DataPaths(environment: ["PI_CODING_AGENT_DIR": temp.path])
        try check("missing file reported", CacheReader.read(paths).error != nil)
        try Data("{}".utf8).write(to: paths.cache)
        try check("empty cache read", CacheReader.read(paths).entries.isEmpty && CacheReader.read(paths).error == nil)
        try Data(repeating: 32, count: Cache.maxBytes + 1).write(to: paths.cache)
        try check("bounded file read", CacheReader.read(paths).error?.contains("1 MiB") == true)
        try check("invalid explicit Node rejected", (try? NodeLocator.locate(explicit: "/does/not/exist")) == nil)
        try check("relative explicit Node rejected", (try? NodeLocator.locate(explicit: "node")) == nil)
        let node = try NodeLocator.locate(explicit: nil)
        try check("stable Node located", !node.path.contains("Cellar"))
        let script = temp.appendingPathComponent("script with spaces.mjs")
        try Data("process.stdout.write('x'.repeat(200000));process.stderr.write('y'.repeat(200000));".utf8).write(to: script)
        let flood = ProcessRunner.run(executable: node, arguments: [script.path], directory: temp, timeout: 5)
        try check("space path and full output sink", flood.status == 0 && flood.failure == nil && flood.output.isEmpty)
        let bounded = ProcessRunner.run(executable: node, arguments: [script.path], directory: temp, timeout: 5, captureVersion: true)
        try check("version probe bounded drain", bounded.status == 0 && bounded.output.count == 65536)
        let nonzero = ProcessRunner.run(executable: node, arguments: ["-e", "process.exit(7)"], directory: temp)
        try check("nonzero exit", nonzero.status == 7 && nonzero.failure != nil)
        let missing = ProcessRunner.run(executable: node, arguments: [temp.appendingPathComponent("missing.mjs").path], directory: temp)
        try check("missing script", missing.status != 0 && missing.failure != nil)
        let timeout = ProcessRunner.run(executable: node, arguments: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], directory: temp, timeout: 0.2)
        try check("timeout force-kill and reap", timeout.failure?.contains("超时") == true && kill(timeout.pid!, 0) == -1)
        let token = Cancellation()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { token.cancel() }
        let cancelled = ProcessRunner.run(executable: node, arguments: ["-e", "setInterval(()=>{},1000)"], directory: temp, timeout: 5, cancellation: token)
        try check("running cancellation and reap", cancelled.failure == "刷新已取消" && kill(cancelled.pid!, 0) == -1)
        let infinite = ProcessRunner.run(executable: node, arguments: ["-e", "while(true)process.stdout.write('x'.repeat(65536))"], directory: temp, timeout: 0.2, captureVersion: true)
        try check("unbounded version output still times out", infinite.failure?.contains("超时") == true && infinite.output.count <= 65536)
        let again = ProcessRunner.run(executable: node, arguments: ["-e", "process.exit(0)"], directory: temp)
        try check("can run after timeout/cancel", again.status == 0)
        return count
    }
}
