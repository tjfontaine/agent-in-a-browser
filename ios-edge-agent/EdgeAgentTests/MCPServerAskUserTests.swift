import XCTest
@testable import EdgeAgent
import MCP

@MainActor
final class MCPServerTests: XCTestCase {
    
    // TDD Step 1: Verify the old iOS tools are deleted and return an error
    func testRemovedIOSToolsReturnError() async {
        let locationResult = await MCPServer.shared.handleToolCall(
            name: "get_location",
            arguments: .object([:])
        )
        XCTAssertTrue(locationResult.isError ?? false)
        guard case .text(let locText) = locationResult.content.first else { return XCTFail() }
        XCTAssertTrue(locText.contains("Unknown tool"), "get_location should be completely removed")
        
        let authResult = await MCPServer.shared.handleToolCall(
            name: "request_authorization",
            arguments: .object(["capability": .string("location")])
        )
        XCTAssertTrue(authResult.isError ?? false)
        guard case .text(let authText) = authResult.content.first else { return XCTFail() }
        XCTAssertTrue(authText.contains("Unknown tool"), "request_authorization should be completely removed")
    }

    // TDD Step 2: Test the async path for ask_user works purely through Swift Concurrency
    func testResolveAskUserWithContinuation() async throws {
        let server = MCPServer.shared
        let requestId = "test-\(UUID().uuidString)"
        
        // We will mock the onAskUser callback since `executeAskUser` triggers it to display UI
        var capturedAskType = ""
        server.onAskUser = { reqId, type, prompt, options in
            if reqId == requestId {
                capturedAskType = type
                // Simulate user tapping a button after a tiny delay
                Task { @MainActor in
                    server.resolveAskUser(requestId: reqId, response: "confirmed")
                }
            }
        }
        defer { server.onAskUser = nil }
        
        // The handleToolCall will internally suspend until the user (our Task above) resolves it
        let result = await server.handleToolCall(name: "ask_user", arguments: .object([
            "type": .string("confirm"),
            "prompt": .string("Are you sure?")
        ]))
        
        XCTAssertEqual(capturedAskType, "confirm")
        XCTAssertFalse(result.isError ?? true)
        guard case .text(let text) = result.content.first else {
            XCTFail("Expected text content")
            return
        }
        XCTAssertEqual(text, "confirmed")
    }

    func testBundleToolsReturnErrorWhenBundleModeDisabled() async {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: "bundleMode")
        defer {
            if let previous {
                defaults.set(previous, forKey: "bundleMode")
            } else {
                defaults.removeObject(forKey: "bundleMode")
            }
        }

        defaults.set(false, forKey: "bundleMode")
        let result = await MCPServer.shared.handleToolCall(
            name: "bundle_get",
            arguments: .object(["app_id": .string("bundle-mode-test")])
        )

        XCTAssertEqual(result.isError, true)
        guard case .text(let text) = result.content.first else {
            XCTFail("Expected text error content")
            return
        }
        XCTAssertTrue(text.contains("App Bundle Mode is disabled"))
    }

    func testBundleGetTreatsEmptyRevisionIdAsLiveBundle() async throws {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: "bundleMode")
        defer {
            if let previous {
                defaults.set(previous, forKey: "bundleMode")
            } else {
                defaults.removeObject(forKey: "bundleMode")
            }
        }

        defaults.set(true, forKey: "bundleMode")
        let appId = "bundle-live-\(UUID().uuidString.prefix(8))"
        _ = try DatabaseManager.shared.ensureProject(id: appId)
        defer {
            try? DatabaseManager.shared.deleteProject(id: appId)
        }

        let result = await MCPServer.shared.handleToolCall(
            name: "bundle_get",
            arguments: .object([
                "app_id": .string(appId),
                "revision_id": .string("")
            ])
        )

        XCTAssertEqual(result.isError, false)
        guard case .text(let text) = result.content.first else {
            XCTFail("Expected text content")
            return
        }
        guard let data = text.data(using: .utf8),
              let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let manifest = obj["manifest"] as? [String: Any] else {
            XCTFail("Expected bundle JSON object with manifest")
            return
        }
        XCTAssertEqual(manifest["appId"] as? String, appId)
    }
}
