import XCTest
@testable import EdgeAgent

final class ConfigManagerTests: XCTestCase {
    
    override func setUp() async throws {
        // Clear UserDefaults before each test
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "provider")
        defaults.removeObject(forKey: "model")
        defaults.removeObject(forKey: "apiKey")
        defaults.removeObject(forKey: "baseUrl")
        defaults.removeObject(forKey: "maxTurns")
    }
    
    @MainActor
    func testDefaultValues() throws {
        let manager = ConfigManager()
        
        XCTAssertEqual(manager.provider, "anthropic")
        XCTAssertEqual(manager.model, "claude-sonnet-4-20250514")
        XCTAssertEqual(manager.apiKey, "")
        XCTAssertEqual(manager.baseUrl, "")
        XCTAssertEqual(manager.maxTurns, 25)
    }
    
    @MainActor
    func testPersistence() throws {
        // Set values
        var manager = ConfigManager()
        manager.provider = "openai"
        manager.model = "gpt-4o"
        manager.apiKey = "sk-test-key"
        manager.maxTurns = 50
        
        // Create new manager - should load from UserDefaults
        let manager2 = ConfigManager()
        
        XCTAssertEqual(manager2.provider, "openai")
        XCTAssertEqual(manager2.model, "gpt-4o")
        XCTAssertEqual(manager2.apiKey, "sk-test-key")
        XCTAssertEqual(manager2.maxTurns, 50)
    }
    
    @MainActor
    func testBuildAgentConfig() throws {
        let manager = ConfigManager()
        manager.provider = "gemini"
        manager.model = "gemini-2.0-flash"
        manager.apiKey = "test-api-key"
        manager.baseUrl = "https://custom.api.com"
        manager.maxTurns = 10
        
        let config = manager.buildAgentConfig()
        
        XCTAssertEqual(config.provider, "gemini")
        XCTAssertEqual(config.model, "gemini-2.0-flash")
        XCTAssertEqual(config.apiKey, "test-api-key")
        XCTAssertEqual(config.baseUrl, "https://custom.api.com")
        XCTAssertEqual(config.maxTurns, 10)
        XCTAssertNotNil(config.mcpServers)
        XCTAssertEqual(config.mcpServers?.count, 1)
        XCTAssertEqual(config.mcpServers?.first?.url, "wasm://mcp-server")
    }
    
    @MainActor
    func testEmptyBaseUrlBecomesNil() throws {
        let manager = ConfigManager()
        manager.baseUrl = ""
        
        let config = manager.buildAgentConfig()
        
        XCTAssertNil(config.baseUrl)
    }
    
    func testAgentConfigEncodesToJSON() throws {
        let config = AgentConfig(
            provider: "anthropic",
            model: "claude-3-5-sonnet",
            apiKey: "test-key",
            baseUrl: nil,
            preamble: nil,
            preambleOverride: nil,
            mcpServers: [MCPServerConfig(url: "wasm://mcp", name: "Test")],
            maxTurns: 25
        )
        
        let data = try JSONEncoder().encode(config)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        
        XCTAssertEqual(json?["provider"] as? String, "anthropic")
        XCTAssertEqual(json?["api_key"] as? String, "test-key")
        XCTAssertNotNil(json?["mcp_servers"])
    }
}
