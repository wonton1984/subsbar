import Foundation
import SubsCore

public enum M2DSuite {
    public static func run(root: URL) throws -> Int {
        var count = 0
        func check(_ name: String, _ ok: Bool) throws {
            guard ok else { throw LocalFailure("FAIL M2D: " + name) }
            count += 1; print("PASS M2D " + name)
        }
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("subsbar-m2d-" + UUID().uuidString + ".json")
        defer { try? FileManager.default.removeItem(at: output) }
        let node = try NodeLocator.locate(explicit: nil, cancellation: Cancellation())
        let result = ProcessRunner.run(executable: node, arguments: [root.appendingPathComponent("macos-app/Tests/m2d-wire.mjs").path, output.path], directory: root)
        try check("Node shared fixture normalization", result.status == 0)
        let wire = try Wire.parse(Data(contentsOf: output))
        let now = Date(timeIntervalSince1970: wire["now"].number! / 1000)
        func displays(_ key: String) -> [MetricDisplay] {
            let report = wire[key]
            return (report["windows"].array + report["metrics"].array).map { MetricDisplay(V1Metric($0), primaryID: report["primaryMetricId"].string, now: now) }
        }
        for key in ["monthly", "legacy", "noReset"] {
            try check("valid Ollama wire " + key, !displays(key).isEmpty && displays(key).allSatisfy(\.valid))
        }
        try check("monthly does not invent legacy windows", displays("monthly").map(\.id) == ["ollama-monthly"])
        let monthly = wire["monthly"]["windows"].array.first ?? .null
        try check("monthly credits preserve used and limit", monthly["used"].number == 7.5 && monthly["limit"].number == 60)
        try check("monthly remaining fraction", displays("monthly").first?.fraction == 0.875)
        try check("legacy actual two windows", displays("legacy").map(\.id) == ["ollama-session", "ollama-weekly"])
        try check("legacy fractional usage becomes percent once", displays("legacy").map(\.fraction) == [0.6, 0.8])
        try check("no reset timestamp invented", wire["noReset"]["windows"].array.allSatisfy { $0["period"]["resetState"].text == "unknown" && $0["period"]["resetsAtMs"] == .null })
        try check("legacy reset remains unknown", wire["legacy"]["windows"].array.allSatisfy { $0["period"]["resetState"].text == "unknown" })
        try check("missing payload not full quota", wire["missingRejected"].bool)
        return count
    }
}
