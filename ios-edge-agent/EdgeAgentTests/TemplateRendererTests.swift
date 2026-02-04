import XCTest
@testable import EdgeAgent

final class TemplateRendererTests: XCTestCase {
    
    // MARK: - Basic Binding Resolution
    
    func testSimpleStringBinding() {
        let template: [String: Any] = [
            "type": "Text",
            "props": ["content": "Hello, {{name}}!"]
        ]
        let data: [String: Any] = ["name": "World"]
        
        let result = TemplateRenderer.render(template: template, data: data)
        
        let props = result["props"] as? [String: Any]
        XCTAssertEqual(props?["content"] as? String, "Hello, World!")
    }
    
    func testNestedPathBinding() {
        let template: [String: Any] = [
            "type": "Text",
            "props": ["content": "{{user.profile.name}}"]
        ]
        let data: [String: Any] = [
            "user": [
                "profile": ["name": "John Doe"]
            ]
        ]
        
        let result = TemplateRenderer.render(template: template, data: data)
        
        let props = result["props"] as? [String: Any]
        XCTAssertEqual(props?["content"] as? String, "John Doe")
    }
    
    func testMultipleBindingsInSameString() {
        let template: [String: Any] = [
            "type": "Text",
            "props": ["content": "{{greeting}}, {{name}}!"]
        ]
        let data: [String: Any] = ["greeting": "Hello", "name": "World"]
        
        let result = TemplateRenderer.render(template: template, data: data)
        
        let props = result["props"] as? [String: Any]
        XCTAssertEqual(props?["content"] as? String, "Hello, World!")
    }
    
    func testMissingBindingReturnsEmptyString() {
        let template: [String: Any] = [
            "type": "Text",
            "props": ["content": "{{missing}}"]
        ]
        let data: [String: Any] = [:]
        
        let result = TemplateRenderer.render(template: template, data: data)
        
        let props = result["props"] as? [String: Any]
        XCTAssertEqual(props?["content"] as? String, "")
    }
    
    // MARK: - Numeric Bindings
    
    func testNumericBinding() {
        let template: [String: Any] = [
            "type": "Text",
            "props": ["height": "{{imageHeight}}"]
        ]
        let data: [String: Any] = ["imageHeight": 120]
        
        let result = TemplateRenderer.render(template: template, data: data)
        
        let props = result["props"] as? [String: Any]
        XCTAssertEqual(props?["height"] as? String, "120")
    }
    
    // MARK: - Children Rendering
    
    func testChildrenAreRendered() {
        let template: [String: Any] = [
            "type": "VStack",
            "props": [
                "children": [
                    [
                        "type": "Text",
                        "props": ["content": "{{title}}"]
                    ],
                    [
                        "type": "Text",
                        "props": ["content": "{{subtitle}}"]
                    ]
                ]
            ]
        ]
        let data: [String: Any] = ["title": "Hello", "subtitle": "World"]
        
        let result = TemplateRenderer.render(template: template, data: data)
        
        let props = result["props"] as? [String: Any]
        let children = props?["children"] as? [[String: Any]]
        XCTAssertEqual(children?.count, 2)
        
        let firstChildProps = children?[0]["props"] as? [String: Any]
        XCTAssertEqual(firstChildProps?["content"] as? String, "Hello")
        
        let secondChildProps = children?[1]["props"] as? [String: Any]
        XCTAssertEqual(secondChildProps?["content"] as? String, "World")
    }
    
    // MARK: - Item Context Rendering
    
    func testRenderWithItemContext() {
        let template: [String: Any] = [
            "type": "Card",
            "props": [
                "title": "{{item.name}}",
                "image": "{{item.imageUrl}}"
            ]
        ]
        let data: [String: Any] = ["baseUrl": "https://example.com"]
        let item: [String: Any] = [
            "name": "Recipe 1",
            "imageUrl": "https://example.com/image.jpg"
        ]
        
        let result = TemplateRenderer.renderWithItem(template: template, data: data, item: item)
        
        let props = result["props"] as? [String: Any]
        XCTAssertEqual(props?["title"] as? String, "Recipe 1")
        XCTAssertEqual(props?["image"] as? String, "https://example.com/image.jpg")
    }
    
    // MARK: - Edge Cases
    
    func testEmptyTemplate() {
        let template: [String: Any] = [:]
        let data: [String: Any] = ["key": "value"]
        
        let result = TemplateRenderer.render(template: template, data: data)
        
        XCTAssertTrue(result.isEmpty)
    }
    
    func testNoBindingsPassesThrough() {
        let template: [String: Any] = [
            "type": "Text",
            "props": ["content": "Static text"]
        ]
        let data: [String: Any] = [:]
        
        let result = TemplateRenderer.render(template: template, data: data)
        
        let props = result["props"] as? [String: Any]
        XCTAssertEqual(props?["content"] as? String, "Static text")
    }
    
    func testPreservesNonStringProps() {
        let template: [String: Any] = [
            "type": "Image",
            "props": [
                "height": 120,
                "shadow": true,
                "cornerRadius": 8.5
            ]
        ]
        let data: [String: Any] = [:]
        
        let result = TemplateRenderer.render(template: template, data: data)
        
        let props = result["props"] as? [String: Any]
        XCTAssertEqual(props?["height"] as? Int, 120)
        XCTAssertEqual(props?["shadow"] as? Bool, true)
        XCTAssertEqual(props?["cornerRadius"] as? Double, 8.5)
    }
}
