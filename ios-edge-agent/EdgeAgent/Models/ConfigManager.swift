import Foundation

/// Configuration for an MCP server
struct MCPServerConfig: Codable {
    let url: String
    let name: String?
}

/// Provider information for LLM configuration
struct ProviderInfo: Codable, Identifiable {
    let id: String
    let name: String
    let defaultBaseUrl: String?
}

/// Model information for LLM configuration
struct ModelInfo: Codable, Identifiable {
    let id: String
    let name: String
}

/// Agent configuration passed to EdgeAgentSession
struct AgentConfig: Codable {
    let provider: String
    let model: String
    let apiKey: String
    let baseUrl: String?
    let preamble: String?
    let preambleOverride: String?
    let mcpServers: [MCPServerConfig]?
    let maxTurns: UInt32?
    

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
    
    // MARK: - App Bundle Feature Flags
    
    @Published var bundleMode: Bool {
        didSet { UserDefaults.standard.set(bundleMode, forKey: "bundleMode") }
    }
    @Published var bundleRepairMode: Bool {
        didSet { UserDefaults.standard.set(bundleRepairMode, forKey: "bundleRepairMode") }
    }
    
    init() {
        let defaults = UserDefaults.standard
        self.provider = defaults.string(forKey: "provider") ?? "anthropic"
        self.model = defaults.string(forKey: "model") ?? "claude-sonnet-4-5"
        self.apiKey = defaults.string(forKey: "apiKey") ?? ""
        self.baseUrl = defaults.string(forKey: "baseUrl") ?? ""
        let storedMaxTurns = defaults.integer(forKey: "maxTurns")
        self.maxTurns = storedMaxTurns == 0 ? 25 : storedMaxTurns
        if defaults.object(forKey: "bundleMode") == nil {
            self.bundleMode = true
        } else {
            self.bundleMode = defaults.bool(forKey: "bundleMode")
        }
        self.bundleRepairMode = defaults.bool(forKey: "bundleRepairMode")
    }
    
    func buildAgentConfig() -> AgentConfig {
        AgentConfig(
            provider: provider,
            model: model,
            apiKey: apiKey,
            baseUrl: baseUrl.isEmpty ? nil : baseUrl,
            preamble: nil,
            preambleOverride: nil,
            mcpServers: [MCPServerConfig(url: "http://127.0.0.1:9292", name: "ios-tools")],
            maxTurns: UInt32(maxTurns)
        )
    }
}
