import XCTest
@testable import EdgeAgent

@MainActor
final class ComponentLibraryNormalizationTests: XCTestCase {
    func testRenderNormalizesLowercaseFlatSchema() {
        let state = ComponentState()
        state.render([
            [
                "type": "scroll",
                "children": [
                    ["type": "text", "content": "Hello", "style": "title"],
                    ["type": "card", "key": "status-card", "title": "Status", "body": "Loading..."]
                ]
            ]
        ])

        XCTAssertEqual(state.rootComponents.count, 1)
        let root = state.rootComponents[0]
        XCTAssertEqual(root["type"] as? String, "ScrollView")

        let rootProps = root["props"] as? [String: Any]
        let children = rootProps?["children"] as? [[String: Any]]
        XCTAssertEqual(children?.count, 2)

        let text = children?[0]
        XCTAssertEqual(text?["type"] as? String, "Text")
        let textProps = text?["props"] as? [String: Any]
        XCTAssertEqual(textProps?["content"] as? String, "Hello")
        XCTAssertEqual(textProps?["size"] as? String, "2xl")

        let card = children?[1]
        XCTAssertEqual(card?["type"] as? String, "Card")
        XCTAssertEqual(card?["key"] as? String, "status-card")
        let cardProps = card?["props"] as? [String: Any]
        XCTAssertEqual(cardProps?["title"] as? String, "Status")
        XCTAssertEqual(cardProps?["body"] as? String, "Loading...")
    }

    func testRenderAndPatchNormalizeProgressAliases() {
        let state = ComponentState()
        state.render([
            ["type": "progress", "key": "progress-1", "value": 0.25]
        ])

        XCTAssertEqual(state.rootComponents.count, 1)
        var root = state.rootComponents[0]
        XCTAssertEqual(root["type"] as? String, "ProgressBar")
        var props = root["props"] as? [String: Any]
        XCTAssertEqual(props?["progress"] as? Double, 0.25, accuracy: 0.0001)

        state.applyPatches([
            ["key": "progress-1", "op": "update", "props": ["value": 0.75]]
        ])

        root = state.rootComponents[0]
        props = root["props"] as? [String: Any]
        XCTAssertEqual(props?["progress"] as? Double, 0.75, accuracy: 0.0001)
    }

    func testAppendPatchNormalizesFlatComponentPayload() {
        let state = ComponentState()
        state.render([
            ["type": "vstack", "key": "root", "children": []]
        ])

        state.applyPatches([
            [
                "key": "root",
                "op": "append",
                "component": ["type": "text", "text": "Appended"]
            ]
        ])

        let root = state.rootComponents[0]
        let rootProps = root["props"] as? [String: Any]
        let children = rootProps?["children"] as? [[String: Any]]
        XCTAssertEqual(children?.count, 1)

        let child = children?[0]
        XCTAssertEqual(child?["type"] as? String, "Text")
        let childProps = child?["props"] as? [String: Any]
        XCTAssertEqual(childProps?["content"] as? String, "Appended")
    }
}
