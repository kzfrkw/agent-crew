import XCTest
@testable import Orders

final class OrdersTests: XCTestCase {
    func testThreeOrders() {
        XCTAssertEqual(listOrders().map(\.item), ["りんご", "みかん", "ぶどう"])
    }
}
