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
        for key in ["agy", "devin", "hideDaily", "dailyOnly", "monthly", "weekly"] {
            try check("valid wire displays " + key, !displays(key).isEmpty && displays(key).allSatisfy(\.valid))
        }
        try check("Antigravity separate pools", Set(displays("agy").map(\.id)).isSuperset(of: ["antigravity-gemini", "antigravity-other"]))
        try check("Antigravity denied never full quota", wire["denied"].bool)
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
