import XCTest
import TestSupport
final class CacheTests: XCTestCase {
    func testSharedContractSuite() throws { XCTAssertGreaterThan(try Suite.run(), 60) }
    func testM1ContractSuite() throws { XCTAssertGreaterThan(try M1Suite.run(), 0) }
}
