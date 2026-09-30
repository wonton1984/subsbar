import Foundation
import Darwin

public struct DataPaths: Sendable {
    public let agent: URL
    public init(environment: [String: String] = ProcessInfo.processInfo.environment) throws {
        if let override = environment["PI_CODING_AGENT_DIR"] {
            guard override.hasPrefix("/"), !override.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw LocalFailure("PI_CODING_AGENT_DIR 必须是非空绝对路径") }
            agent = URL(fileURLWithPath: override, isDirectory: true)
        } else { agent = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".pi/agent") }
    }
    public var cache: URL { agent.appendingPathComponent("subs-bar-cache.json") }
    public var state: URL { agent.appendingPathComponent("subs-bar-state.json") }
}
public struct Snapshot: Sendable {
    public var entries: [String: Entry] = [:]
    public var diagnostics: [String: String] = [:]
    public var error: String?
    public var shared: Data?
    public init() {}
    public func merging(_ incoming: Snapshot, now: Date = Date()) -> Snapshot {
        if incoming.error != nil {
            var kept = self; kept.error = "\(incoming.error!)；显示上次数据"; return kept
        }
        var result = incoming
        for (id, old) in entries {
            guard let new = incoming.entries[id], new.valid else {
                result.entries[id] = old
                result.diagnostics[id] = "本次缓存缺失或无效，显示上次数据"
                continue
            }
            if let previous = old.fetchedAt, previous <= now.addingTimeInterval(300), new.fetchedAt == nil || new.fetchedAt! < previous {
                result.entries[id] = old
                result.diagnostics[id] = "检测到较旧或无时间缓存，保留上次数据"
            }
        }
        return result
    }
}
public enum CacheReader {
    static func bounded(_ url: URL) throws -> Data {
        let handle: FileHandle
        do { handle = try FileHandle(forReadingFrom: url) } catch { throw LocalFailure("缓存文件不存在或不可读") }
        defer { try? handle.close() }
        let data = try handle.read(upToCount: Cache.maxBytes + 1) ?? Data()
        guard data.count <= Cache.maxBytes else { throw LocalFailure("缓存超过 1 MiB 限制") }
        return data
    }
    public static func read(_ paths: DataPaths) -> Snapshot {
        var snapshot = Snapshot()
        for delay in [0.0, 0.05, 0.15, 0.30] {
            if delay > 0 { Thread.sleep(forTimeInterval: delay) }
            do { snapshot.entries = try Cache.parse(bounded(paths.cache)); snapshot.error = nil; break }
            catch { snapshot.error = (error as? LocalFailure)?.description ?? "缓存暂不可读" }
        }
        for delay in [0.0, 0.05, 0.15] {
            if delay > 0 { Thread.sleep(forTimeInterval: delay) }
            if let data = try? bounded(paths.state), (try? JSONSerialization.jsonObject(with: data)) is [String: Any] { snapshot.shared = data; break }
        }
        return snapshot
    }
}

// Narrow Sendable exception: the sole mutable property is protected by NSLock.
// Process itself never crosses queues; the worker polls this cancellation flag.
public final class Cancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    public init() {}
    public func cancel() { lock.lock(); value = true; lock.unlock() }
    public var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return value }
}
public struct RunResult: Sendable {
    public let status: Int32?, failure: String?, pid: Int32?
    public let output: Data // only used for bounded Node version probe; refresh uses /dev/null
}
public enum ProcessRunner {
    public static func run(executable: URL, arguments: [String], directory: URL?, environment: [String: String]? = nil, timeout: TimeInterval = 120, cancellation: Cancellation = Cancellation(), captureVersion: Bool = false) -> RunResult {
        if cancellation.cancelled { return RunResult(status: nil, failure: "刷新已取消", pid: nil, output: Data()) }
        let process = Process()
        process.executableURL = executable; process.arguments = arguments; process.currentDirectoryURL = directory
        if let environment { process.environment = environment }
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let pipe = captureVersion ? Pipe() : nil
        process.standardOutput = pipe ?? FileHandle.nullDevice as Any
        if let pipe { _ = fcntl(pipe.fileHandleForReading.fileDescriptor, F_SETFL, O_NONBLOCK) }
        do { try process.run() } catch { return RunResult(status: nil, failure: "无法启动子进程，请检查可执行文件及权限", pid: nil, output: Data()) }
        let pid = process.processIdentifier
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var output = Data()
        func drain() {
            guard let pipe else { return }
            var buffer = [UInt8](repeating: 0, count: 4096)
            for _ in 0..<16 {
                let count = Darwin.read(pipe.fileHandleForReading.fileDescriptor, &buffer, buffer.count)
                if count <= 0 { break }
                if output.count < 65536 { output.append(contentsOf: buffer.prefix(min(count, 65536 - output.count))) }
            }
        }
        var failure: String?
        while process.isRunning {
            drain()
            if cancellation.cancelled || ProcessInfo.processInfo.systemUptime >= deadline {
                failure = cancellation.cancelled ? "刷新已取消" : "刷新超时（120 秒上限）"
                process.terminate()
                let grace = ProcessInfo.processInfo.systemUptime + 0.5
                while process.isRunning && ProcessInfo.processInfo.systemUptime < grace { drain(); Thread.sleep(forTimeInterval: 0.02) }
                if process.isRunning { kill(pid, SIGKILL) }
                break
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
        process.waitUntilExit(); drain()
        if failure == nil && process.terminationStatus != 0 { failure = "刷新进程失败（退出码 \(process.terminationStatus)）" }
        return RunResult(status: process.terminationStatus, failure: failure, pid: pid, output: output)
    }
}
public enum NodeLocator {
    public static func locate(explicit: String?, environment: [String: String] = ProcessInfo.processInfo.environment, cancellation: Cancellation = Cancellation()) throws -> URL {
        let candidates: [String]
        if let explicit {
            guard explicit.hasPrefix("/") else { throw LocalFailure("nativeNodePath 必须是绝对路径") }
            candidates = [explicit]
        } else {
            candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"] + (environment["PATH"] ?? "").split(separator: ":").filter { $0.hasPrefix("/") }.map { "\($0)/node" }
        }
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            let url = URL(fileURLWithPath: candidate)
            let result = ProcessRunner.run(executable: url, arguments: ["--version"], directory: nil, timeout: 3, cancellation: cancellation, captureVersion: true)
            let version = String(data: result.output, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if result.status == 0, version.hasPrefix("v"), let major = Int(version.dropFirst().split(separator: ".").first ?? ""), major >= 22 { return url }
            if cancellation.cancelled { throw LocalFailure("刷新已取消") }
        }
        throw LocalFailure(explicit == nil ? "找不到可用的 Node.js ≥22" : "nativeNodePath 不可用或版本低于 22；请修正显式配置")
    }
}
public enum RefreshContract {
    public static func outcomes(before: Snapshot, after: Snapshot, failure: String?, now: Date = Date()) -> [String: String] {
        var output: [String: String] = [:]
        for p in Provider.all where p.supported {
            guard after.error == nil, let entry = after.entries[p.id], entry.valid, let time = entry.fetchedAt, time <= now.addingTimeInterval(300) else {
                output[p.id] = "✗ \(failure ?? after.error ?? "本次缓存缺失或无效")"; continue
            }
            if time > (before.entries[p.id]?.fetchedAt ?? .distantPast), time >= now.addingTimeInterval(-600) { output[p.id] = "已更新" }
            else { output[p.id] = "✗ \(failure ?? "本次未获得新数据，显示缓存；具体接口原因不可用")" }
        }
        return output
    }
}
public enum LegacyRefreshGuard {
    public static func conflict(cancellation: Cancellation = Cancellation()) -> Bool {
        let result = ProcessRunner.run(executable: URL(fileURLWithPath: "/bin/launchctl"), arguments: ["print", "gui/\(getuid())/com.subsbar.refresh"], directory: nil, timeout: 3, cancellation: cancellation)
        // Unknown check failure is treated conservatively as a conflict.
        return result.status == 0 || result.status == nil || result.failure?.contains("超时") == true
    }
}
