import Foundation
import CoreFoundation

/// JSON transport only: config semantics and schema validation belong to Node.
public indirect enum Wire: Sendable, Equatable, Codable {
    case object([String: Wire]), array([Wire]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let x = try? c.decode(Bool.self) { self = .bool(x) }
        else if let x = try? c.decode(Double.self) { self = .number(x) }
        else if let x = try? c.decode(String.self) { self = .string(x) }
        else if let x = try? c.decode([String: Wire].self) { self = .object(x) }
        else { self = .array(try c.decode([Wire].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .object(let v): try c.encode(v); case .array(let v): try c.encode(v); case .string(let v): try c.encode(v); case .number(let v): try c.encode(v); case .bool(let v): try c.encode(v); case .null: try c.encodeNil() }
    }
    public subscript(_ key: String) -> Wire { object[key] ?? .null }
    public var object: [String: Wire] { if case .object(let v) = self { v } else { [:] } }
    public var array: [Wire] { if case .array(let v) = self { v } else { [] } }
    public var string: String? { if case .string(let v) = self { v } else { nil } }
    public var text: String { string ?? "" }
    public var number: Double? { if case .number(let v) = self, v.isFinite, v >= 0, v <= 9_007_199_254_740_991 { v } else { nil } }
    public var bool: Bool { if case .bool(let v) = self { v } else { false } }
    public var isObject: Bool { if case .object = self { true } else { false } }
    public var isArray: Bool { if case .array = self { true } else { false } }
    public func encoded() throws -> Data { try JSONEncoder().encode(self) }
    public func setting(_ key: String, _ value: Wire) -> Wire { var o = object; o[key] = value; return .object(o) }
    public static func strings(_ values: [String]) -> Wire { .array(values.map(Wire.string)) }
    public static func parse(_ data: Data) throws -> Wire {
        guard data.count <= 1_048_576, String(data: data, encoding: .utf8) != nil else { throw LocalFailure("invalid-json") }
        var scanner = JSONScanner(bytes: Array(data))
        try scanner.value(depth: 0); scanner.space()
        guard scanner.index == scanner.bytes.count else { throw LocalFailure("invalid-json") }
        do { return try JSONDecoder().decode(Wire.self, from: data) } catch { throw LocalFailure("invalid-json") }
    }
}
// Reject duplicate keys and excessive nesting before Foundation can silently discard them.
private struct JSONScanner {
    let bytes: [UInt8]; var index = 0
    mutating func space() { while index < bytes.count && [9,10,13,32].contains(bytes[index]) { index += 1 } }
    mutating func expect(_ byte: UInt8) throws { space(); guard index < bytes.count, bytes[index] == byte else { throw LocalFailure("invalid-json") }; index += 1 }
    mutating func string() throws -> String {
        space(); let start = index; try expect(34)
        while index < bytes.count {
            let b = bytes[index]; index += 1
            if b == 92 { guard index < bytes.count else { break }; index += 1 }
            else if b == 34 { return try JSONDecoder().decode(String.self, from: Data(bytes[start..<index])) }
        }
        throw LocalFailure("invalid-json")
    }
    mutating func value(depth: Int) throws {
        guard depth <= 32 else { throw LocalFailure("json-depth") }; space()
        guard index < bytes.count else { throw LocalFailure("invalid-json") }
        switch bytes[index] {
        case 123:
            index += 1; space(); var keys = Set<String>()
            if index < bytes.count && bytes[index] == 125 { index += 1; return }
            while true {
                let key = try string(); guard keys.insert(key).inserted else { throw LocalFailure("duplicate-key") }
                try expect(58); try value(depth: depth + 1); space()
                if index < bytes.count && bytes[index] == 125 { index += 1; return }; try expect(44)
            }
        case 91:
            index += 1; space(); if index < bytes.count && bytes[index] == 93 { index += 1; return }
            while true { try value(depth: depth + 1); space(); if index < bytes.count && bytes[index] == 93 { index += 1; return }; try expect(44) }
        case 34: _ = try string()
        default:
            let start = index
            while index < bytes.count && ![9,10,13,32,44,93,125].contains(bytes[index]) { index += 1 }
            guard index > start else { throw LocalFailure("invalid-json") }
            let primitive = try JSONDecoder().decode(Wire.self, from: Data(bytes[start..<index]))
            if case .number(let n) = primitive, !n.isFinite || abs(n) > 9_007_199_254_740_991 { throw LocalFailure("invalid-number") }
        }
    }
}

public struct ConfigDocument: Sendable {
    public let config: Wire, revision: Double, contentToken: String
    public init(_ response: Wire) throws {
        guard response["schemaVersion"].number == 1, response["kind"].text == "config", response["config"].isObject,
              response["config"]["schemaVersion"].number == 1, let revision = response["revision"].number,
              revision.rounded() == revision, let token = response["contentToken"].string else { throw LocalFailure("schema-unsupported") }
        self.config = response["config"]; self.revision = revision; self.contentToken = token
    }
    public func submission(patch: Wire) -> Wire { .object(["baseRevision": .number(revision), "contentToken": .string(contentToken), "patch": patch]) }
}
