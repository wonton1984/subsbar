import Foundation
import SubsCore

public enum M2CSuite {
    public static func run(root: URL) throws -> Int {
        var count = 0
        func check(_ name: String, _ ok: Bool) throws {
            guard ok else { throw LocalFailure("FAIL M2C: " + name) }
            count += 1; print("PASS M2C " + name)
        }
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("subsbar-m2c-" + UUID().uuidString + ".json")
        defer { try? FileManager.default.removeItem(at: output) }
        let node = try NodeLocator.locate(explicit: nil, cancellation: Cancellation())
        let result = ProcessRunner.run(executable: node, arguments: [root.appendingPathComponent("macos-app/Tests/m2c-wire.mjs").path, output.path], directory: root)
        try check("Node shared fixture normalization", result.status == 0)
        let wire = try Wire.parse(Data(contentsOf: output))
        let now = Date(timeIntervalSince1970: wire["now"].number! / 1000)
        func displays(_ key: String) -> [MetricDisplay] {
            let report = wire[key]
            return (report["windows"].array + report["metrics"].array).map { MetricDisplay(V1Metric($0), primaryID: report["primaryMetricId"].string, now: now) }
        }
        for key in ["agy", "agyGroups", "devin", "hideDaily", "dailyOnly", "monthly", "weekly"] {
            try check("valid wire displays " + key, !displays(key).isEmpty && displays(key).allSatisfy(\.valid))
        }
        try check("Antigravity separate pools", Set(displays("agy").map(\.id)).isSuperset(of: ["antigravity-gemini", "antigravity-other"]))
        try check("Antigravity denied never full quota", wire["denied"].bool)
        let agyReport = wire["agyGroups"]
        let provider = V1Provider(.object(["providerId": .string("antigravity"), "profileId": .string("synthetic"), "scopeKey": .string("scope-synthetic-agy"), "source": .object(["dataSourceId": .string("antigravity-cli")]), "lastSuccessAtMs": agyReport["capturedAtMs"], "status": .string("ok"), "dataDisposition": .string("current"), "report": agyReport]))
        try check("Antigravity full entry preserves four windows", !provider.invalid && provider.windows.count == 4)
        try check("Antigravity menu ring uses primary remaining", abs((provider.iconFraction(at: now) ?? -1) - 0.4) < 0.00001)
        let groups = displays("agyGroups")
        try check("Antigravity official groups four quota windows", groups.count == 4 && groups.allSatisfy { $0.valid && $0.showsBar })
        let remaining: [String: Double] = ["antigravity-gemini": 0.4, "antigravity-gemini-weekly": 0.73, "antigravity-other": 0.91, "antigravity-other-weekly": 0.88]
        for (id, value) in remaining {
            let display = groups.first { $0.id == id }
            try check("Antigravity remaining fraction " + id, abs((display?.fraction ?? -1) - value) < 0.00001)
            try check("Antigravity reset visible " + id, display?.resetFull != nil && display?.resetShort != "重置时间未知")
        }
        try check("Antigravity envelope tokens not credits", wire["agyGroups"]["metrics"].array.isEmpty)

        try check("Devin daily and weekly separate", Set(displays("devin").map(\.id)).isSuperset(of: ["devin-daily", "devin-weekly"]))
        try check("Devin hide daily omits", !displays("hideDaily").contains { $0.id == "devin-daily" })
        try check("Devin daily never becomes weekly", displays("dailyOnly").map(\.id) == ["devin-daily"])
        try check("Grok month label", displays("monthly").contains { $0.id == "grok-monthly" && $0.label.contains("月") })
        try check("Grok week label", displays("weekly").contains { $0.id == "grok-weekly" && $0.label.contains("周") })
        try check("Grok disabled PAYG no bar", !displays("monthly").contains { $0.id == "payg-cap" })
        try check("Grok PAYG valid standalone quota", displays("grok").contains { $0.id == "payg-cap" && $0.valid && $0.showsBar && !$0.isPrimary })
        let cap = wire["capOnly"]["metrics"].array.first { $0["id"].text == "payg-cap" } ?? .null
        let capDisplay = displays("capOnly").first
        try check("Grok cap-only stays unknown usage", cap["state"].text == "limit-only" && cap["used"] == .null && cap["remaining"] == .null && cap["quotaState"].text == "unknown")
        try check("Grok cap-only has no fabricated percentage", capDisplay?.valid == true && capDisplay?.fraction == nil && capDisplay?.summary.contains("已用未知") == true)
        try check("Grok PAYG period independent", cap["period"]["kind"].text == "unknown" && cap["period"]["resetState"].text == "unknown" && wire["capOnly"]["windows"].array.isEmpty)
        return count
    }
}
