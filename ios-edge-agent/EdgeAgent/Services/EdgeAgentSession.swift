//
//  EdgeAgentSession.swift
//  EdgeAgent
//
//  Created on 2026/02/08.
//
//  Drop-in replacement for NativeAgentHost using OpenFoundationModels.
//  All providers go through OpenAILanguageModel → LanguageModelSession.
//

import Foundation
import Combine
import OSLog
import MCP
import MCPServerKit
import WASIShims
import OpenFoundationModelsOpenAI  // re-exports OpenFoundationModels

// MARK: - Provider Configuration

/// Maps ConfigManager provider IDs to OpenAI-compatible endpoints.
enum LLMProvider: String, CaseIterable, Sendable {
    case openai = "openai"
    case anthropic = "anthropic"
    case gemini = "gemini"
    case openrouter = "openrouter"

    var defaultBaseURL: String {
        switch self {
        case .openai: return "https://api.openai.com/v1"
        case .anthropic: return "https://api.anthropic.com/v1"
        case .gemini: return "https://generativelanguage.googleapis.com/v1beta/openai"
        case .openrouter: return "https://openrouter.ai/api/v1"
        }
    }
}

// MARK: - EdgeAgentSession

/// ObservableObject session that replaces NativeAgentHost.
/// Interface-compatible: events, isReady, currentStreamText, send(), cancel().
@MainActor
final class EdgeAgentSession: NSObject, ObservableObject, @unchecked Sendable {

    static let shared = EdgeAgentSession()

    // MARK: - Published State (matches NativeAgentHost)

    @Published var events: [AgentEvent] = []
    @Published var isReady = false
    @Published var currentStreamText = ""
    @Published private(set) var isCancelled = false

    // MARK: - Private State

    private var session: LanguageModelSession?
    private var currentTask: Task<Void, Never>?
    private var activeProvider: String = ""
    private var activeModel: String = ""

    /// Stored config for session re-creation (clearHistory).
    private var lastConfig: AgentConfig?

    /// Max tool call turns before stopping the agent loop.
    private var maxTurns: Int = 25

    /// Counter for tool calls in the current turn, used to enforce maxTurns.
    private var toolCallCount = 0

    /// Connected remote MCP clients (e.g. NativeMCPHost shell-tools).
    private var remoteClients: [MCP.Client] = []

    override init() {
        super.init()
        configureScriptRenderCallbacks()
    }

    // MARK: - Public API

    /// No-op for interface compatibility (no WASM to load).
    func load() async throws {
        // Nothing to load — sessions are created in createAgent/start
    }

    /// Creates a new session from ConfigManager-compatible AgentConfig.
    func createAgent(config: AgentConfig) async {
        cancel()

        // Disconnect any previous remote clients
        for client in remoteClients {
            await client.disconnect()
        }
        remoteClients = []

        lastConfig = config  // Store for clearHistory re-creation

        let providerID = config.provider
        let modelID = config.model
        let apiKey = config.apiKey

        activeProvider = providerID
        activeModel = modelID
        maxTurns = Int(config.maxTurns ?? 25)

        let provider = LLMProvider(rawValue: providerID)

        let effectiveBaseURL: URL
        if let baseUrl = config.baseUrl, !baseUrl.isEmpty, let url = URL(string: baseUrl) {
            effectiveBaseURL = url
        } else if let url = URL(string: provider?.defaultBaseURL ?? "https://api.openai.com/v1") {
            effectiveBaseURL = url
        } else {
            effectiveBaseURL = URL(string: "https://api.openai.com/v1")!
        }

        let model = OpenAILanguageModel(
            apiKey: apiKey,
            model: modelID,
            baseURL: effectiveBaseURL
        )

        // Use the system prompt from preambleOverride (SuperApp prompt) or default instructions
        let instructions: String = config.preambleOverride ?? config.preamble ?? AgentInstructions.defaultInstructionsText

        // Event sink for tool call events — shared by local and remote tools
        let eventSink: ToolEventSink = { [weak self] event in
            guard let self else { return }
            self.events.append(event)

            // Count tool calls to enforce maxTurns
            if case .toolCall = event {
                self.toolCallCount += 1
                if self.toolCallCount >= self.maxTurns {
                    Log.agent.warning("EdgeAgentSession: maxTurns (\(self.maxTurns)) reached, cancelling")
                    self.events.append(.error("Reached maximum tool call limit (\(self.maxTurns) turns)"))
                    self.currentTask?.cancel()
                }
            }
        }

        // Use real MCP clients for all tools, including local ios-tools.
        var tools: [any OpenFoundationModels.Tool] = []
        var mcpServers = config.mcpServers ?? []
        if !mcpServers.contains(where: { $0.url == MCPServer.shared.baseURL }) {
            mcpServers.insert(MCPServerConfig(url: MCPServer.shared.baseURL, name: "ios-tools"), at: 0)
        }
        for serverConfig in mcpServers {
            guard let url = URL(string: serverConfig.url) else {
                Log.agent.warning("EdgeAgentSession: invalid MCP server URL: \(serverConfig.url)")
                continue
            }
            do {
                let client = try await MCPToolBridge.connectRemoteServer(url: url)
                remoteClients.append(client)
                let remoteTools = try await MCPToolBridge.loadRemoteTools(client: client, eventSink: eventSink)
                tools.append(contentsOf: remoteTools)
                Log.agent.info("EdgeAgentSession: connected to MCP server \(serverConfig.name ?? serverConfig.url) with \(remoteTools.count) tools")
            } catch {
                Log.agent.warning("EdgeAgentSession: failed to connect to MCP server \(serverConfig.name ?? serverConfig.url): \(error.localizedDescription)")
            }
        }

        self.session = LanguageModelSession(
            model: model,
            tools: tools,
            instructions: instructions
        )

        isReady = true
        events.append(.ready)
        Log.agent.info("EdgeAgentSession: created with provider=\(providerID) model=\(modelID) maxTurns=\(maxTurns) tools=\(tools.count)")
    }

    /// Also accept ConfigManager directly (convenience).
    func start(config: ConfigManager) async {
        let agentConfig = AgentConfig(
            provider: config.provider == "apple-on-device" ? "openai" : config.provider,
            model: config.model,
            apiKey: config.apiKey,
            baseUrl: config.baseUrl.isEmpty ? nil : config.baseUrl,
            preamble: nil,
            preambleOverride: nil,
            mcpServers: nil,
            maxTurns: nil
        )
        await createAgent(config: agentConfig)
    }

    /// Fire-and-forget send — matches NativeAgentHost.send(_:).
    func send(_ message: String) {
        guard session != nil else {
            Log.agent.info("EdgeAgentSession: no session available")
            return
        }

        isCancelled = false
        toolCallCount = 0  // Reset per-message turn counter
        currentTask = Task { [weak self] in
            await self?.sendInternal(message)
        }
    }

    /// Cancel any in-flight generation.
    func cancel() {
        isCancelled = true
        currentTask?.cancel()
        currentTask = nil
        // Note: remote clients are NOT disconnected on cancel — they persist across messages
        Log.agent.info("EdgeAgentSession: cancelled by user")
    }

    /// Clear conversation history and re-create session with same config.
    func clearHistory() async {
        events.removeAll()
        currentStreamText = ""
        toolCallCount = 0

        // Re-create session to reset the transcript
        if let config = lastConfig {
            await createAgent(config: config)
            Log.agent.info("EdgeAgentSession: history cleared, session re-created")
        } else {
            Log.agent.info("EdgeAgentSession: history cleared (no config to re-create session)")
        }
    }

    // MARK: - Internal

    private func sendInternal(_ message: String) async {
        guard let session else { return }

        events.append(.streamStart)
        currentStreamText = ""

        do {
            // Use streaming for progressive text updates.
            // Tool calls are handled internally by the session — our DynamicMCPTool
            // emits .toolCall/.toolResult events via the event sink.
            let stream = session.streamResponse(to: message)
            var lastText = ""

            for try await partial in stream {
                // Check cancellation inside the stream loop for responsive cancel
                guard !isCancelled else {
                    currentStreamText = ""
                    events.append(.cancelled)
                    return
                }

                let text = partial.content
                if text != lastText {
                    lastText = text
                    currentStreamText = text
                }
            }

            // Final complete event
            currentStreamText = ""
            events.append(.complete(lastText))
            Log.agent.info("EdgeAgentSession: response complete (\(lastText.count) chars)")

        } catch is CancellationError {
            currentStreamText = ""
            events.append(.cancelled)
        } catch {
            currentStreamText = ""
            Log.agent.error("EdgeAgentSession: error: \(error.localizedDescription)")
            events.append(.error("LLM error: \(error.localizedDescription)"))
        }
    }

    private func configureScriptRenderCallbacks() {
        // Scripts can render even before the LLM session is fully initialized.
        ScriptExecutor.shared.onRenderShow = { componentsJSON in
            DispatchQueue.main.async {
                switch Self.parseRenderComponents(from: componentsJSON) {
                case .success(let parsedComponents):
                    MCPServer.shared.onRenderUI?(parsedComponents)
                case .failure(let reason):
                    Log.agent.warning("EdgeAgentSession: rejected ios.render.show payload: \(reason)")
                }
            }
            switch Self.parseRenderComponents(from: componentsJSON) {
            case .success:
                return "rendered-from-script"
            case .failure(let reason):
                return "error: \(reason)"
            }
        }

        ScriptExecutor.shared.onRenderPatch = { patchesJSON in
            DispatchQueue.main.async {
                switch Self.parseRenderPatches(from: patchesJSON) {
                case .success(let parsedPatches):
                    MCPServer.shared.onPatchUI?(parsedPatches)
                case .failure(let reason):
                    Log.agent.warning("EdgeAgentSession: rejected ios.render.patch payload: \(reason)")
                }
            }
            switch Self.parseRenderPatches(from: patchesJSON) {
            case .success:
                return "ok"
            case .failure(let reason):
                return "error: \(reason)"
            }
        }
    }

    private enum BridgeParseResult {
        case success([[String: Any]])
        case failure(String)
    }

    private static func parseRenderComponents(from rawJSON: String) -> BridgeParseResult {
        guard let data = rawJSON.data(using: .utf8) else {
            return .failure("render.show payload is not valid UTF-8")
        }
        guard let parsed = try? JSONSerialization.jsonObject(with: data) else {
            return .failure("render.show payload is not valid JSON")
        }
        if let components = parsed as? [[String: Any]] {
            return .success(components)
        }
        if let root = parsed as? [String: Any] {
            if let components = root["components"] as? [[String: Any]] {
                return .success(components)
            }
            if root["type"] != nil || root["props"] != nil || root["key"] != nil {
                return .success([root])
            }
        }
        return .failure("render.show expected a component object/array")
    }

    private static func parseRenderPatches(from rawJSON: String) -> BridgeParseResult {
        guard let data = rawJSON.data(using: .utf8) else {
            return .failure("render.patch payload is not valid UTF-8")
        }
        guard let parsed = try? JSONSerialization.jsonObject(with: data) else {
            return .failure("render.patch payload is not valid JSON")
        }
        if let patches = parsed as? [[String: Any]] {
            return .success(patches)
        }
        if let root = parsed as? [String: Any] {
            if let patches = root["patches"] as? [[String: Any]] {
                return .success(patches)
            }
            if root["key"] != nil || root["op"] != nil {
                return .success([root])
            }
        }
        return .failure("render.patch expected a patch object/array")
    }
}

// MARK: - Errors

enum EdgeAgentError: LocalizedError {
    case sessionNotStarted
    case providerNotAvailable(String)

    var errorDescription: String? {
        switch self {
        case .sessionNotStarted:
            return "Agent session not started. Configure a provider first."
        case .providerNotAvailable(let name):
            return "Provider '\(name)' is not available on this device."
        }
    }
}
