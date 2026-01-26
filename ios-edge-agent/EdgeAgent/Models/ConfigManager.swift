import Foundation

/// Configuration for an MCP server
struct MCPServerConfig: Codable {
    let url: String
    let name: String?
}

/// Provider information from WASM API
struct ProviderInfo: Codable, Identifiable {
    let id: String
    let name: String
    let defaultBaseUrl: String?
}

/// Model information from WASM API
struct ModelInfo: Codable, Identifiable {
    let id: String
    let name: String
}

/// Agent configuration matching the WIT interface
struct AgentConfig: Codable {
    let provider: String
    let model: String
    let apiKey: String
    let baseUrl: String?
    let preamble: String?
    let preambleOverride: String?
    let mcpServers: [MCPServerConfig]?
    let maxTurns: UInt32?
    
    // Note: WASM interface expects camelCase keys, so we use default encoding
    // (Swift property names are already camelCase)
}

/// Manages user configuration with persistence
@MainActor
class ConfigManager: ObservableObject {
    @Published var provider: String {
        didSet { UserDefaults.standard.set(provider, forKey: "provider") }
    }
    @Published var model: String {
        didSet { UserDefaults.standard.set(model, forKey: "model") }
    }
    @Published var apiKey: String {
        didSet { UserDefaults.standard.set(apiKey, forKey: "apiKey") }
    }
    @Published var baseUrl: String {
        didSet { UserDefaults.standard.set(baseUrl, forKey: "baseUrl") }
    }
    @Published var maxTurns: Int {
        didSet { UserDefaults.standard.set(maxTurns, forKey: "maxTurns") }
    }
    
    init() {
        let defaults = UserDefaults.standard
        self.provider = defaults.string(forKey: "provider") ?? "anthropic"
        self.model = defaults.string(forKey: "model") ?? "claude-sonnet-4-20250514"
        self.apiKey = defaults.string(forKey: "apiKey") ?? ""
        self.baseUrl = defaults.string(forKey: "baseUrl") ?? ""
        self.maxTurns = defaults.integer(forKey: "maxTurns")
        if self.maxTurns == 0 { self.maxTurns = 25 }
    }
    
    func buildAgentConfig() -> AgentConfig {
        AgentConfig(
            provider: provider,
            model: model,
            apiKey: apiKey,
            baseUrl: baseUrl.isEmpty ? nil : baseUrl,
            preamble: nil,
            preambleOverride: nil,
            mcpServers: [MCPServerConfig(url: "wasm://mcp-server", name: "Local MCP")],
            maxTurns: UInt32(maxTurns)
        )
    }
}
