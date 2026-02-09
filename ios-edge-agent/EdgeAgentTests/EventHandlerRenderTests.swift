import XCTest
@testable import EdgeAgent

@MainActor
final class EventHandlerRenderTests: XCTestCase {
    func testRenderActionTreatsSuccessAckAsNoOpSuccess() async {
        let handler = EventHandler()
        var renderCallCount = 0

        handler.onScriptEval = { _, _, _, _, _ in
            (true, #"{"success": true}"#)
        }
        handler.onRenderComponents = { _ in
            renderCallCount += 1
        }

        let result = await handler.execute(
            handler: .scriptEval(
                code: "42",
                file: nil,
                args: [],
                resultMode: .local,
                onResult: .render,
                onError: nil
            ),
            context: EventContext(itemData: nil)
        )

        XCTAssertTrue(result.success)
        XCTAssertEqual(renderCallCount, 0)
    }

    func testRenderActionParsesWrappedComponentsPayload() async {
        let handler = EventHandler()
        var rendered: [[String: Any]] = []

        handler.onScriptEval = { _, _, _, _, _ in
            (
                true,
                #"{"components":[{"type":"text","content":"Hello"}]}"#
            )
        }
        handler.onRenderComponents = { components in
            rendered = components
        }

        let result = await handler.execute(
            handler: .scriptEval(
                code: "42",
                file: nil,
                args: [],
                resultMode: .local,
                onResult: .render,
                onError: nil
            ),
            context: EventContext(itemData: nil)
        )

        XCTAssertTrue(result.success)
        XCTAssertEqual(rendered.count, 1)
        XCTAssertEqual(rendered.first?["type"] as? String, "text")
    }
}
