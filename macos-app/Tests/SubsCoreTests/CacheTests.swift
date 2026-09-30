import XCTest
import TestSupport
final class CacheTests: XCTestCase {
    func testSharedContractSuite() throws { XCTAssertGreaterThan(try Suite.run(), 60) }
}
