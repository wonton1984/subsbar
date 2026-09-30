// swift-tools-version: 6.0
import PackageDescription
import Foundation
var targets: [Target] = [
    .target(name: "SubsCore"),
    .executableTarget(name: "SubsBar", dependencies: ["SubsCore"]),
    .target(name: "TestSupport", dependencies: ["SubsCore"], path: "Tests/TestSupport"),
    .executableTarget(name: "CoreChecks", dependencies: ["TestSupport"], path: "Tests/CoreChecks")
]
// Apple's CLT installation lacks XCTest. The same suite can run with full Xcode.
if ProcessInfo.processInfo.environment["SUBSBAR_XCTEST"] == "1" {
    targets.append(.testTarget(name: "SubsCoreTests", dependencies: ["TestSupport"]))
}
let package = Package(name: "SubsBar", platforms: [.macOS(.v13)], products: [.executable(name: "SubsBar", targets: ["SubsBar"]), .executable(name: "CoreChecks", targets: ["CoreChecks"])], targets: targets, swiftLanguageModes: [.v6])
