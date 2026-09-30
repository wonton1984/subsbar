import Foundation
import Darwin

public struct BridgeResponse: Sendable {
    public let exitCode: Int32, value: Wire
    public var errorCode: String? { value["kind"].text == "error" ? value["error"]["code"].text : nil }
}
public struct NodeBridge: Sendable {
    public let node: URL, root: URL
    public let configPath: String?
    public let environment: [String: String]
    public init(node: URL, root: URL, configPath: String? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.node = node; self.root = root; self.configPath = configPath; self.environment = environment
    }
    public func call(_ arguments: [String], input: Wire? = nil, timeout: TimeInterval = 120, cancellation: Cancellation = Cancellation()) throws -> BridgeResponse {
        let cli = root.appendingPathComponent("core/cli.mjs")
        guard FileManager.default.fileExists(atPath: cli.path) else { throw LocalFailure("core-unavailable") }
        var args = [cli.path] + arguments
        if let configPath { args += ["--config", configPath] }
        let inputData = try input?.encoded() ?? Data()
        guard inputData.count <= 1_048_576 else { throw LocalFailure("input-too-large") }
        let p = Process(), output = Pipe(), stdin = Pipe()
        p.executableURL = node; p.arguments = args; p.currentDirectoryURL = root; p.environment = environment
        p.standardOutput = output; p.standardError = FileHandle.nullDevice
        p.standardInput = input == nil ? FileHandle.nullDevice : stdin.fileHandleForReading
        _ = fcntl(output.fileHandleForReading.fileDescriptor, F_SETFL, O_NONBLOCK)
        _ = fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETFL, O_NONBLOCK)
        signal(SIGPIPE, SIG_IGN)
        guard !cancellation.cancelled else { throw LocalFailure("cancelled") }
        do { try p.run() } catch { throw LocalFailure("node-unavailable") }
        try? output.fileHandleForWriting.close(); try? stdin.fileHandleForReading.close()
        defer { try? output.fileHandleForReading.close(); try? stdin.fileHandleForWriting.close() }
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var bytes = Data(), offset = 0, inputClosed = input == nil, failure: String?
        func drain() {
            var buffer = [UInt8](repeating: 0, count: 8192)
            for _ in 0..<16 {
                let n = Darwin.read(output.fileHandleForReading.fileDescriptor, &buffer, buffer.count)
                if n <= 0 { break }
                if bytes.count + n > 1_048_576 { failure = "output-too-large"; return }
                bytes.append(contentsOf: buffer.prefix(n))
            }
        }
        while p.isRunning {
            if !inputClosed {
                if offset < inputData.count {
                    let n = inputData.withUnsafeBytes { raw in Darwin.write(stdin.fileHandleForWriting.fileDescriptor, raw.baseAddress!.advanced(by: offset), min(8192, inputData.count - offset)) }
                    if n > 0 { offset += n }
                    else if errno != EAGAIN && errno != EWOULDBLOCK { failure = "stdin-failed" }
                }
                if offset == inputData.count { try? stdin.fileHandleForWriting.close(); inputClosed = true }
            }
            drain()
            if cancellation.cancelled { failure = "cancelled" }
            if ProcessInfo.processInfo.systemUptime >= deadline { failure = "timeout" }
            if failure != nil {
                p.terminate() // Node propagates SIGTERM to its AbortController and releases owned leases.
                let grace = ProcessInfo.processInfo.systemUptime + 0.5
                while p.isRunning && ProcessInfo.processInfo.systemUptime < grace { drain(); Thread.sleep(forTimeInterval: 0.01) }
                if p.isRunning { kill(p.processIdentifier, SIGKILL) }
                break
            }
            Thread.sleep(forTimeInterval: 0.01)
        }
        p.waitUntilExit(); drain()
        if let failure {
            // A graceful cancellation still carries committed provider results.
            if failure == "cancelled", p.terminationStatus == 3,
               let wire = try? Wire.parse(bytes), wire["schemaVersion"].number == 1,
               wire["kind"].text == "usage", wire["request"]["outcome"].text == "cancelled" {
                return BridgeResponse(exitCode: 3, value: wire)
            }
            throw LocalFailure(failure)
        }
        let wire = try Wire.parse(bytes)
        guard [0,2,3,4].contains(p.terminationStatus), wire.isObject, wire["schemaVersion"].number == 1 else { throw LocalFailure("schema-unsupported") }
        if p.terminationStatus == 2 && wire["kind"].text != "error" || p.terminationStatus == 3 && wire["kind"].text != "usage" || p.terminationStatus == 0 && wire["kind"].text == "error" { throw LocalFailure("invalid-response") }
        return BridgeResponse(exitCode: p.terminationStatus, value: wire)
    }
}
