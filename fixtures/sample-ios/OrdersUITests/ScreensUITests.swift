import XCTest

final class ScreensUITests: XCTestCase {
    func testScreens() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["りんご"].waitForExistence(timeout: 10))
        shot("s1-orders")
    }

    private func shot(_ name: String) {
        let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
