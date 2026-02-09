//
//  MCPToolBridge.swift
//  EdgeAgent
//
//  Bridges MCP tools into OpenFoundationModels Tool protocol.
//  Each MCP tool definition becomes a DynamicMCPTool that the
//  LanguageModelSession can call during generation.
//

import Foundation
import OSLog
import MCP
import OpenFoundationModels
import OpenFoundationModelsCore

// MARK: - Event Sink

/// Callback type for emitting AgentEvents from tool calls.
/// Used by DynamicMCPTool to notify the UI of tool activity.
typealias ToolEventSink = @Sendable @MainActor (AgentEvent) -> Void

// MARK: - DynamicMCPTool

/// A single MCP tool wrapped as an OpenFoundationModels Tool.
///
/// Uses `GeneratedContent` as the passthrough argument type — the LLM sends
/// JSON arguments, which GeneratedContent parses, and we convert to MCP `Value`
/// for forwarding to MCPServer.handleToolCall.
struct DynamicMCPTool: OpenFoundationModels.Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let description: String
    let parameters: GenerationSchema

    /// Optional callback to emit AgentEvents for the UI timeline.
    let eventSink: ToolEventSink?

    /// Called by LanguageModelSession when the model invokes this tool.
    func call(arguments: GeneratedContent) async throws -> String {
        Log.agent.info("MCPTool: calling '\(name)' with: \(arguments.jsonString.prefix(200))")

        // Emit toolCall event for the UI timeline
        await emitEvent(.toolCall(name))

        // Convert GeneratedContent → MCP Value for handleToolCall
        let mcpArgs = generatedContentToValue(arguments)

        // For ask_user, emit a dedicated askUser event so it appears in the timeline
        if name == "ask_user" {
            let requestId = UUID().uuidString
            var askType = "confirm"
            var prompt = ""
            var options: [String]? = nil

            if case .structure(let props, _) = arguments.kind {
                if let typeContent = props["type"], case .string(let t) = typeContent.kind {
                    askType = t
                }
                if let promptContent = props["prompt"], case .string(let p) = promptContent.kind {
                    prompt = p
                }
                if let optionsContent = props["options"], case .array(let arr) = optionsContent.kind {
                    options = arr.compactMap { item -> String? in
                        if case .string(let s) = item.kind { return s }
                        return nil
                    }
                }
            }

            await emitEvent(.askUser(id: requestId, type: askType, prompt: prompt, options: options))
        }

        // Forward to MCPServer
        let result = await MCPServer.shared.handleToolCall(name: name, arguments: mcpArgs)

        // Extract text content from result
        let output = result.content.map { content -> String in
            switch content {
            case .text(let text):
                return text
            case .image(let data, let mimeType, _):
                return "[image: \(mimeType), \(data.count) bytes]"
            case .audio(let data, let mimeType):
                return "[audio: \(mimeType), \(data.count) bytes]"
            case .resource(let uri, _, let text):
                return text ?? "[resource: \(uri)]"
            }
        }.joined(separator: "\n")

        let isError = result.isError ?? false

        if isError {
            Log.agent.warning("MCPTool: '\(name)' returned error: \(output.prefix(200))")
        } else {
            Log.agent.info("MCPTool: '\(name)' returned \(output.count) chars")
        }


        // Emit toolResult event for the UI timeline
        await emitEvent(.toolResult(name: name, output: output, isError: isError))

        return output
    }

    /// Emit an event via the sink if one was provided.
    @MainActor
    private func emitEvent(_ event: AgentEvent) {
        eventSink?(event)
    }
}

// MARK: - RemoteMCPTool

/// An MCP tool on a remote server, proxied via `MCP.Client`.
///
/// Same UI behavior as `DynamicMCPTool` (emits `.toolCall`/`.toolResult` events)
/// but forwards the actual call through the MCP SDK client instead of MCPServer.shared.
struct RemoteMCPTool: OpenFoundationModels.Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let description: String
    let parameters: GenerationSchema

    /// The MCP client connected to the remote server.
    let client: MCP.Client

    /// Optional callback to emit AgentEvents for the UI timeline.
    let eventSink: ToolEventSink?

    func call(arguments: GeneratedContent) async throws -> String {
        Log.agent.info("RemoteMCPTool: calling '\(name)' with: \(arguments.jsonString.prefix(200))")

        await emitEvent(.toolCall(name))

        // Convert GeneratedContent → [String: MCP.Value] for callTool
        let mcpArgs = generatedContentToValue(arguments)
        var argsDict: [String: MCP.Value]? = nil
        if case .object(let dict) = mcpArgs {
            argsDict = dict
        }

        let result = try await client.callTool(name: name, arguments: argsDict)

        // Extract text from result content
        let output = result.content.map { content -> String in
            switch content {
            case .text(let text):
                return text
            case .image(let data, let mimeType, _):
                return "[image: \(mimeType), \(data.count) bytes]"
            case .resource(let uri, _, let text):
                return text ?? "[resource: \(uri)]"
            case .audio(let data, let mimeType):
                return "[audio: \(mimeType), \(data.count) bytes]"
            }
        }.joined(separator: "\n")

        let isError = result.isError ?? false

        if isError {
            Log.agent.warning("RemoteMCPTool: '\(name)' returned error: \(output.prefix(200))")
        } else {
            Log.agent.info("RemoteMCPTool: '\(name)' returned \(output.count) chars")
        }

        await emitEvent(.toolResult(name: name, output: output, isError: isError))
        return output
    }

    @MainActor
    private func emitEvent(_ event: AgentEvent) {
        eventSink?(event)
    }
}

// MARK: - MCPToolBridge

/// Builds the array of tools from MCPServer's local definitions + any remote MCP servers.
enum MCPToolBridge {

    /// Fetch all MCP tool definitions and convert them to OpenFoundationModels Tools.
    ///
    /// - Parameters:
    ///   - remoteClients: Optional array of connected `MCP.Client` instances for remote servers.
    ///   - eventSink: Callback to emit AgentEvents when tools are called.
    ///     Pass `nil` to suppress events (e.g. for testing).
    @MainActor static func loadTools(
        remoteClients: [MCP.Client] = [],
        eventSink: ToolEventSink? = nil
    ) -> [any OpenFoundationModels.Tool] {
        // 1. Local tools from MCPServer.shared
        let mcpTools = MCPServer.shared.toolDefinitions

        let tools: [any OpenFoundationModels.Tool] = mcpTools.compactMap { tool in
            let schema = mcpInputSchemaToGenerationSchema(
                description: tool.description ?? "MCP tool",
                inputSchema: tool.inputSchema
            )

            return DynamicMCPTool(
                name: tool.name,
                description: tool.description ?? "MCP tool",
                parameters: schema,
                eventSink: eventSink
            )
        }

        Log.agent.info("MCPToolBridge: loaded \(tools.count) local tools: \(tools.map(\.name).joined(separator: ", "))")

        // 2. Remote tools — will be loaded asynchronously after createAgent
        // (see loadRemoteTools below)

        return tools
    }

    /// Connect to a remote MCP server and return a configured client.
    ///
    /// Uses `HTTPClientTransport` with `streaming: false` for compatibility
    /// with simple JSON-RPC HTTP servers like NativeMCPHost.
    static func connectRemoteServer(url: URL) async throws -> MCP.Client {
        let transport = HTTPClientTransport(
            endpoint: url,
            streaming: false
        )
        let client = MCP.Client(name: "EdgeAgent", version: "1.0")
        try await client.connect(transport: transport)
        Log.agent.info("MCPToolBridge: connected to remote MCP server at \(url)")
        return client
    }

    /// Fetch tool definitions from a connected remote MCP client and wrap them
    /// as OpenFoundationModels Tools.
    static func loadRemoteTools(
        client: MCP.Client,
        eventSink: ToolEventSink? = nil
    ) async throws -> [any OpenFoundationModels.Tool] {
        let result = try await client.listTools()
        let tools: [any OpenFoundationModels.Tool] = result.tools.compactMap { tool in
            let schema = mcpInputSchemaToGenerationSchema(
                description: tool.description ?? "Remote MCP tool",
                inputSchema: tool.inputSchema
            )

            return RemoteMCPTool(
                name: tool.name,
                description: tool.description ?? "Remote MCP tool",
                parameters: schema,
                client: client,
                eventSink: eventSink
            )
        }

        Log.agent.info("MCPToolBridge: loaded \(tools.count) remote tools: \(tools.map(\.name).joined(separator: ", "))")
        return tools
    }
}

// MARK: - Type Conversions

/// Convert GeneratedContent → MCP Value for forwarding to MCPServer.handleToolCall.
private func generatedContentToValue(_ content: GeneratedContent) -> MCP.Value? {
    switch content.kind {
    case .null:
        return .null
    case .bool(let b):
        return .bool(b)
    case .number(let d):
        // Preserve integer representation when possible
        if d.truncatingRemainder(dividingBy: 1) == 0 && d >= Double(Int.min) && d <= Double(Int.max) {
            return .int(Int(d))
        }
        return .double(d)
    case .string(let s):
        return .string(s)
    case .array(let arr):
        return .array(arr.map { generatedContentToValue($0) ?? .null })
    case .structure(let props, _):
        var dict: [String: MCP.Value] = [:]
        for (key, val) in props {
            dict[key] = generatedContentToValue(val) ?? .null
        }
        return .object(dict)
    }
}

/// Convert MCP inputSchema (Value) → OpenFoundationModels GenerationSchema.
private func mcpInputSchemaToGenerationSchema(description: String, inputSchema: MCP.Value) -> GenerationSchema {
    var schemaProperties: [GenerationSchema.Property] = []

    if case .object(let schema) = inputSchema,
       case .object(let properties) = schema["properties"] {
        var requiredNames: Set<String> = []
        if case .array(let reqArray) = schema["required"] {
            for item in reqArray {
                if case .string(let s) = item {
                    requiredNames.insert(s)
                }
            }
        }

        for (propName, propValue) in properties {
            var propDescription: String? = nil
            var propType: String = "string"

            if case .object(let propObj) = propValue {
                if case .string(let desc) = propObj["description"] {
                    propDescription = desc
                }
                if case .string(let t) = propObj["type"] {
                    propType = t
                }
            }

            let isRequired = requiredNames.contains(propName)
            let property = makeProperty(
                name: propName,
                description: propDescription,
                jsonType: propType,
                isRequired: isRequired
            )
            schemaProperties.append(property)
        }
    }

    return GenerationSchema(
        type: GeneratedContent.self,
        description: description,
        properties: schemaProperties
    )
}

/// Create a GenerationSchema.Property with the correctly typed Generable type.
private func makeProperty(name: String, description: String?, jsonType: String, isRequired: Bool) -> GenerationSchema.Property {
    let effectiveDescription: String?
    if !isRequired {
        effectiveDescription = (description ?? "") + " (optional)"
    } else {
        effectiveDescription = description
    }

    switch jsonType {
    case "string":
        return GenerationSchema.Property(name: name, description: effectiveDescription, type: String.self)
    case "number", "integer":
        return GenerationSchema.Property(name: name, description: effectiveDescription, type: Double.self)
    case "boolean":
        return GenerationSchema.Property(name: name, description: effectiveDescription, type: Bool.self)
    default:
        return GenerationSchema.Property(name: name, description: effectiveDescription, type: GeneratedContent.self)
    }
}
