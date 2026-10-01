import Foundation
import SubsCore

public enum M2BSuite {
    public static func run(root: URL) throws -> Int {
        var count = 0
        func check(_ name: String, _ ok: Bool) throws {
            guard ok else { throw LocalFailure("FAIL M2B: " + name) }
            count += 1; print("PASS M2B " + name)
        }
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("subsbar-m2b-" + UUID().uuidString + ".json")
        defer { try? FileManager.default.removeItem(at: output) }
        let node = try NodeLocator.locate(explicit: nil, cancellation: Cancellation())
        let result = ProcessRunner.run(executable: node, arguments: [root.appendingPathComponent("macos-app/Tests/m2b-wire.mjs").path, output.path], directory: root)
        try check("Node shared fixture normalization", result.status == 0)
        let wire = try Wire.parse(Data(contentsOf: output))
        let now = Date(timeIntervalSince1970: wire["now"].number! / 1000)
        func displays(_ key: String) -> [MetricDisplay] {
            let report = wire[key]
            return (report["windows"].array + report["metrics"].array).map { MetricDisplay(V1Metric($0), primaryID: report["primaryMetricId"].string, now: now) }
        }
        for key in ["credits", "premium", "unlimited", "zai", "router", "noLimit"] {
            try check("valid wire displays " + key, !displays(key).isEmpty && displays(key).allSatisfy(\.valid))
        }
        try check("Copilot AI credits label", displays("credits").contains { $0.id == "ai-credits" && $0.label == "AI credits" })
        try check("Copilot premium label", displays("premium").contains { $0.id == "premium-requests" && $0.label == "Premium requests" })
        try check("Copilot unlimited has no fabricated bar", displays("unlimited").contains { $0.summary == "无限" && !$0.showsBar })
        try check("ZAI 5h and weekly", displays("zai").contains { $0.id == "five-hour" && $0.showsBar } && displays("zai").contains { $0.id == "weekly" && $0.showsBar })
        try check("OpenRouter Key quota label", displays("router").contains { $0.id == "key-limit" && $0.label.contains("Key") && $0.showsBar })
        try check("OpenRouter key headroom never account balance", displays("router").allSatisfy { $0.kind != "balance" })
        try check("OpenRouter uncapped no invented bar", displays("noLimit").allSatisfy { !$0.showsBar && $0.kind != "balance" })
        try check("OpenRouter unavailable balance explanation", Presentation.diagnostic("openrouter-credits-unavailable").contains("账户余额不可用"))
        try check("CN guide says unverified", ProviderConnectionPresentation.note("zai")?.contains("未经真实账户验证") == true)
        return count
    }
}
