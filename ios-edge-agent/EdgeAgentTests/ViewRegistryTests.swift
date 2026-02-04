import XCTest
@testable import EdgeAgent

@MainActor
final class ViewRegistryTests: XCTestCase {
    
    var registry: ViewRegistry!
    
    override func setUp() {
        super.setUp()
        registry = ViewRegistry.shared
        // Clear state before each test
        registry.invalidateAllViews()
    }
    
    override func tearDown() {
        registry.invalidateAllViews()
        super.tearDown()
    }
    
    // MARK: - View Registration
    
    func testRegisterView() {
        let template: [[String: Any]] = [
            ["type": "Text", "props": ["content": "{{message}}"]]
        ]
        
        registry.registerView(
            name: "TestView",
            components: template,
            version: "1.0.0"
        )
        
        XCTAssertTrue(registry.hasView(name: "TestView"))
    }
    
    func testGetRegisteredView() {
        let template: [[String: Any]] = [
            ["type": "Text", "props": ["content": "Hello"]]
        ]
        
        registry.registerView(name: "SimpleView", components: template)
        
        let retrieved = registry.getView(name: "SimpleView")
        XCTAssertNotNil(retrieved)
        XCTAssertEqual(retrieved?.count, 1)
    }
    
    func testVersionTracking() {
        let template1: [[String: Any]] = [["type": "Text", "props": [:]]]
        let template2: [[String: Any]] = [["type": "Image", "props": [:]]]
        
        registry.registerView(name: "VersionedView", components: template1, version: "1.0.0")
        registry.registerView(name: "VersionedView", components: template2, version: "2.0.0")
        
        // Latest version should be retrievable
        let view = registry.getView(name: "VersionedView")
        let type = view?.first?["type"] as? String
        XCTAssertEqual(type, "Image")
    }
    
    // MARK: - Show View with Data
    
    func testShowViewWithData() {
        let template: [[String: Any]] = [
            ["type": "Text", "props": ["content": "{{greeting}}"]]
        ]
        
        registry.registerView(name: "GreetingView", components: template)
        registry.showView(name: "GreetingView", data: ["greeting": "Hello, World!"])
        
        let currentComponents = registry.currentComponents
        XCTAssertEqual(currentComponents.count, 1)
        
        let props = (currentComponents.first?["props"] as? [String: Any])
        XCTAssertEqual(props?["content"] as? String, "Hello, World!")
    }
    
    func testShowViewUpdatesCurrentView() {
        let template: [[String: Any]] = [["type": "Text", "props": [:]]]
        
        registry.registerView(name: "View1", components: template)
        registry.registerView(name: "View2", components: template)
        
        registry.showView(name: "View1")
        XCTAssertEqual(registry.currentViewName, "View1")
        
        registry.showView(name: "View2")
        XCTAssertEqual(registry.currentViewName, "View2")
    }
    
    // MARK: - Navigation Stack
    
    func testNavigationStackPush() {
        let template: [[String: Any]] = [["type": "Text", "props": [:]]]
        
        registry.registerView(name: "Home", components: template)
        registry.registerView(name: "Detail", components: template)
        
        registry.showView(name: "Home")
        registry.showView(name: "Detail")
        
        XCTAssertEqual(registry.navigationStack.count, 2)
    }
    
    func testPopView() {
        let template: [[String: Any]] = [["type": "Text", "props": [:]]]
        
        registry.registerView(name: "Home", components: template)
        registry.registerView(name: "Detail", components: template)
        
        registry.showView(name: "Home", data: ["from": "home"])
        registry.showView(name: "Detail", data: ["from": "detail"])
        
        let popped = registry.popView()
        
        XCTAssertTrue(popped)
        XCTAssertEqual(registry.currentViewName, "Home")
    }
    
    func testPopViewOnEmptyStackReturnsFalse() {
        registry.invalidateAllViews()
        
        let popped = registry.popView()
        XCTAssertFalse(popped)
    }
    
    // MARK: - Update Data
    
    func testUpdateViewData() {
        let template: [[String: Any]] = [
            ["type": "Text", "props": ["content": "Count: {{count}}"]]
        ]
        
        registry.registerView(name: "CounterView", components: template)
        registry.showView(name: "CounterView", data: ["count": 0])
        
        // Update the data
        registry.updateData(["count": 5])
        
        let props = registry.currentComponents.first?["props"] as? [String: Any]
        XCTAssertEqual(props?["content"] as? String, "Count: 5")
    }
    
    // MARK: - Invalidation
    
    func testInvalidateView() {
        let template: [[String: Any]] = [["type": "Text", "props": [:]]]
        
        registry.registerView(name: "TempView", components: template)
        XCTAssertTrue(registry.hasView(name: "TempView"))
        
        registry.invalidateView(name: "TempView")
        XCTAssertFalse(registry.hasView(name: "TempView"))
    }
    
    func testInvalidateAllViews() {
        let template: [[String: Any]] = [["type": "Text", "props": [:]]]
        
        registry.registerView(name: "View1", components: template)
        registry.registerView(name: "View2", components: template)
        registry.registerView(name: "View3", components: template)
        
        registry.invalidateAllViews()
        
        XCTAssertFalse(registry.hasView(name: "View1"))
        XCTAssertFalse(registry.hasView(name: "View2"))
        XCTAssertFalse(registry.hasView(name: "View3"))
    }
    
    // MARK: - Edge Cases
    
    func testShowUnregisteredViewDoesNothing() {
        let initialCount = registry.navigationStack.count
        
        registry.showView(name: "NonExistent")
        
        XCTAssertEqual(registry.navigationStack.count, initialCount)
    }
}
