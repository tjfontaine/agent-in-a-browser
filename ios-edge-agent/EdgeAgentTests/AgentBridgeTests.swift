import XCTest
@testable import EdgeAgent

@MainActor
final class AgentBridgeTests: XCTestCase {
    
    /// Test that WASM modules load and isReady becomes true
    func testWasmLoadsAndBecomesReady() async throws {
        let bridge = AgentBridge()
        
        // Attach to window (required for WKWebView JS execution)
        bridge.attachToWindow()
        
        // Wait up to 30 seconds for WASM to load
        let timeout = Date().addingTimeInterval(30)
        while !bridge.isReady && Date() < timeout {
            try await Task.sleep(nanoseconds: 100_000_000) // 100ms
        }
        
        XCTAssertTrue(bridge.isReady, "WASM should have loaded and set isReady to true")
    }
    
    /// Test that listProviders returns data after WASM is ready
    func testListProvidersReturnsData() async throws {
        let bridge = AgentBridge()
        bridge.attachToWindow()
        
        // Wait for ready
        let timeout = Date().addingTimeInterval(30)
        while !bridge.isReady && Date() < timeout {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        
        guard bridge.isReady else {
            XCTFail("WASM did not become ready - cannot test listProviders")
            return
        }
        
        let providers = await bridge.listProviders()
        
        XCTAssertFalse(providers.isEmpty, "listProviders should return at least one provider")
        
        // Verify we have expected providers
        let providerIds = providers.map { $0.id }
        XCTAssertTrue(providerIds.contains("anthropic"), "Should include anthropic provider")
        XCTAssertTrue(providerIds.contains("openai"), "Should include openai provider")
        XCTAssertTrue(providerIds.contains("gemini"), "Should include gemini provider")
    }
    
    /// Test that listModels returns data for a provider
    func testListModelsReturnsData() async throws {
        let bridge = AgentBridge()
        bridge.attachToWindow()
        
        // Wait for ready
        let timeout = Date().addingTimeInterval(30)
        while !bridge.isReady && Date() < timeout {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        
        guard bridge.isReady else {
            XCTFail("WASM did not become ready - cannot test listModels")
            return
        }
        
        let models = await bridge.listModels(providerId: "anthropic")
        
        XCTAssertFalse(models.isEmpty, "listModels should return at least one model for anthropic")
        
        // Verify we have Claude models
        let modelIds = models.map { $0.id }
        let hasClaudeModel = modelIds.contains { $0.contains("claude") }
        XCTAssertTrue(hasClaudeModel, "Should include at least one Claude model")
    }
}
