import Foundation
import CoreLocation
import MCP
import Network
import OSLog
import WASIShims


// MARK: - iOS MCP Server

/// Local MCP server that provides iOS-specific tools to the headless agent.
/// Uses the official Swift MCP SDK with HTTPServerTransport.
///
/// Usage:
/// 1. Start server: `await MCPServer.shared.start()`
/// 2. Pass URL to agent config: `mcpServers: [{url: "http://localhost:9292"}]`
/// Box for passing mutable values across isolation domains synchronized by semaphores.
/// All access must be externally synchronized (e.g. via DispatchSemaphore).
private final class UnsafeBox<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

/// 3. Stop on app background: `MCPServer.shared.stop()`
@MainActor
class MCPServer: NSObject {
    static let shared = MCPServer()
    
    private let port: UInt16 = 9292
    private var isRunning = false
    private var server: Server?
    private var listener: NWListener?
    
    // Dedicated queue for HTTP processing to avoid blocking main thread
    private let httpQueue = DispatchQueue(label: "com.edgeagent.mcpserver.http", qos: .userInitiated)
    
    // Location services
    private let locationManager = CLLocationManager()
    private var lastLocation: CLLocation?
    
    // Render callback - called when script invokes ios.render.show()
    nonisolated(unsafe) var onRenderUI: (([[String: Any]]) -> Void)?
    
    // Patch callback - called when script invokes ios.render.patch()
    nonisolated(unsafe) var onPatchUI: (([[String: Any]]) -> Void)?
    

    // Ask user callback - called when agent invokes ask_user.
    // The closure receives (requestId, type, prompt, options) and must eventually call the response closure with the user's answer.
    nonisolated(unsafe) var onAskUser: ((_ requestId: String, _ type: String, _ prompt: String, _ options: [String]?) -> Void)?
    
    // Continuation for pending ask_user requests (keyed by requestId)
    var askUserContinuations = [String: CheckedContinuation<String, Never>]()
    let askUserLock = NSLock()
    
    // Semaphore-based ask_user for legacy HTTP path (blocks httpQueue until user responds)
    // The semaphore is signaled from MainActor when the user taps a response.
    nonisolated(unsafe) var askUserSemaphores = [String: DispatchSemaphore]()
    nonisolated(unsafe) var askUserResponses = [String: String]()
    
    /// Call this from the UI when the user responds to an ask_user request
    func resolveAskUser(requestId: String, response: String) {
        askUserLock.lock()
        let continuation = askUserContinuations.removeValue(forKey: requestId)
        let semaphore = askUserSemaphores.removeValue(forKey: requestId)
        if semaphore != nil {
            askUserResponses[requestId] = response
        }
        askUserLock.unlock()
        
        // Resume async continuation (MCPServerKit path)
        continuation?.resume(returning: response)
        
        // Signal semaphore (legacy HTTP path) — unblocks httpQueue
        if let semaphore {
            Log.mcp.info("[ask_user] Signaling semaphore for requestId=\(requestId)")
            semaphore.signal()
        }
    }
    private override init() {
        super.init()
        Task { @MainActor in
            setupLocationManager()
        }
        // Wire permission audit callback (Phase 4)
        ScriptPermissions.shared.onAudit = { appId, scriptName, capability, action, actor in
            try? AppBundleRepository().logPermissionAudit(
                appId: appId, scriptName: scriptName,
                capability: capability, action: action, actor: actor
            )
        }
    }
    
    // MARK: - Server Lifecycle
    
    func start() async throws {
        guard !isRunning else { return }
        
        // Create MCP server with tools capability
        server = Server(
            name: "ios-tools",
            version: "1.0.0",
            capabilities: .init(tools: .init())
        )
        
        guard let server = server else { return }
        
        // Register tool list handler
        await server.withMethodHandler(ListTools.self) { [weak self] _ in
            return .init(tools: self?.toolDefinitions ?? [])
        }
        
        // Register tool call handler
        await server.withMethodHandler(CallTool.self) { [weak self] params in
            guard let self = self else {
                return .init(content: [.text("Server not available")], isError: true)
            }
            // Wrap arguments dict in Value.object
            let wrappedArgs: Value? = params.arguments.map { .object($0) }
            return await self.handleToolCall(name: params.name, arguments: wrappedArgs)
        }
        
        // Start HTTP server using Network.framework
        try await startHTTPServer()
        
        isRunning = true
        let serverPort = self.port
        Log.mcp.info("Started on http://localhost:\(serverPort)")
    }
    
    func stop() {
        listener?.cancel()
        isRunning = false
        Log.mcp.info(" Stopped")
    }
    
    var baseURL: String {
        "http://localhost:\(port)"
    }
    
    // MARK: - Tool Definitions
    
    nonisolated var toolDefinitions: [Tool] {
        [
            Tool(
                name: "get_location",
                description: "Get the device's current GPS location. Returns {status, lat, lon}. If status is 'permission_required' or 'denied', use request_authorization first.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([:])
                ])
            ),
            Tool(
                name: "request_authorization",
                description: "Request iOS system authorization for a capability. Shows native iOS permission dialog. Capabilities: 'location', 'bluetooth', 'camera', 'microphone', 'photos'. Returns {granted: bool, status: string}.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "capability": .object([
                            "type": .string("string"),
                            "description": .string("The capability to request: location, bluetooth, camera, microphone, photos"),
                            "enum": .array([.string("location"), .string("bluetooth"), .string("camera"), .string("microphone"), .string("photos")])
                        ])
                    ]),
                    "required": .array([.string("capability")])
                ])
            ),
            

            
            // MARK: - Script Lifecycle Tools
            
            Tool(
                name: "save_script",
                description: "Save a reusable TypeScript script to the app-scoped registry. Scripts are written to the sandbox filesystem at /apps/{app_id}/scripts/{name}.ts so they can import each other.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "name": .object([
                            "type": .string("string"),
                            "description": .string("Unique script name (kebab-case, e.g. 'weather-widget')")
                        ]),
                        "source": .object([
                            "type": .string("string"),
                            "description": .string("TypeScript/JavaScript source code")
                        ]),
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("App/project ID that this script belongs to")
                        ]),
                        "description": .object([
                            "type": .string("string"),
                            "description": .string("Human-readable description of what the script does")
                        ]),
                        "app_name": .object([
                            "type": .string("string"),
                            "description": .string("Optional human-readable app name used to label the launcher project")
                        ]),
                        "app_summary": .object([
                            "type": .string("string"),
                            "description": .string("Optional app summary used when creating a new launcher project row")
                        ]),
                        "permissions": .object([
                            "type": .string("array"),
                            "description": .string("Required ios.* bridge capabilities (e.g. ['contacts','health'])"),
                            "items": .object(["type": .string("string")])
                        ]),
                        "version": .object([
                            "type": .string("string"),
                            "description": .string("Semver version (default '1.0.0')")
                        ])
                    ]),
                    "required": .array([.string("name"), .string("source"), .string("app_id")])
                ])
            ),
            Tool(
                name: "list_scripts",
                description: "List all saved scripts for an app with name, description, version, and capabilities.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("App/project ID to list scripts for")
                        ])
                    ]),
                    "required": .array([.string("app_id")])
                ])
            ),
            Tool(
                name: "get_script",
                description: "Get a script's full source code by name within an app.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "name": .object([
                            "type": .string("string"),
                            "description": .string("Name of the script to retrieve")
                        ]),
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("App/project ID the script belongs to")
                        ])
                    ]),
                    "required": .array([.string("name"), .string("app_id")])
                ])
            ),
            Tool(
                name: "run_script",
                description: "Execute a saved script by name within an app. The script is loaded from the app's sandbox directory and evaluated via the WASM runtime.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "name": .object([
                            "type": .string("string"),
                            "description": .string("Name of the script to run")
                        ]),
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("App/project ID the script belongs to")
                        ]),
                        "args": .object([
                            "type": .string("array"),
                            "description": .string("Optional arguments to pass to the script"),
                            "items": .object(["type": .string("string")])
                        ])
                    ]),
                    "required": .array([.string("name"), .string("app_id")])
                ])
            ),
            
            // MARK: - Bundle Management Tools
            
            Tool(
                name: "bundle_get",
                description: "Get the app bundle JSON. If revision_id is omitted, builds a live bundle from current DB state.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("App/project ID")
                        ]),
                        "revision_id": .object([
                            "type": .string("string"),
                            "description": .string("Optional specific revision to retrieve")
                        ])
                    ]),
                    "required": .array([.string("app_id")])
                ])
            ),
            Tool(
                name: "bundle_put",
                description: "Save a bundle revision. Mode 'draft' creates a revision without promoting. Mode 'promote' creates and immediately promotes the revision.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("App/project ID")
                        ]),
                        "bundle_json": .object([
                            "type": .string("string"),
                            "description": .string("The full bundle JSON string")
                        ]),
                        "mode": .object([
                            "type": .string("string"),
                            "description": .string("'draft' or 'promote'"),
                            "enum": .array([.string("draft"), .string("promote")])
                        ])
                    ]),
                    "required": .array([.string("app_id"), .string("bundle_json"), .string("mode")])
                ])
            ),
            Tool(
                name: "bundle_patch",
                description: "Apply patches to an app's bundle artifacts. Each patch targets a template or script by name.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("App/project ID")
                        ]),
                        "patches": .object([
                            "type": .string("array"),
                            "description": .string("Array of patches. Each patch: {target: 'template'|'script', name: string, data: object}"),
                            "items": .object(["type": .string("object")])
                        ])
                    ]),
                    "required": .array([.string("app_id"), .string("patches")])
                ])
            ),
            Tool(
                name: "bundle_run",
                description: "Execute an app's script as a tracked run. Creates a run record and returns the run_id along with the execution result.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("App/project ID")
                        ]),
                        "entrypoint": .object([
                            "type": .string("string"),
                            "description": .string("Script name to execute")
                        ]),
                        "args": .object([
                            "type": .string("array"),
                            "description": .string("Optional arguments"),
                            "items": .object(["type": .string("string")])
                        ]),
                        "revision_id": .object([
                            "type": .string("string"),
                            "description": .string("Optional revision to associate with the run (defaults to 'HEAD')")
                        ]),
                        "repair_for_run_id": .object([
                            "type": .string("string"),
                            "description": .string("If provided, this run is a repair retry for the specified failed run_id. Subject to repair policy limits.")
                        ])
                    ]),
                    "required": .array([.string("app_id"), .string("entrypoint")])
                ])
            ),
            Tool(
                name: "bundle_run_status",
                description: "Get the current status of a tracked run.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "run_id": .object([
                            "type": .string("string"),
                            "description": .string("Run ID returned from bundle_run")
                        ])
                    ]),
                    "required": .array([.string("run_id")])
                ])
            ),
            Tool(
                name: "bundle_repair_trace",
                description: "List all repair attempts for a given run.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "run_id": .object([
                            "type": .string("string"),
                            "description": .string("Run ID to get repair trace for")
                        ])
                    ]),
                    "required": .array([.string("run_id")])
                ])
            ),
            // Phase 5: Reuse tools
            Tool(
                name: "bundle_export",
                description: "Export an app bundle as a portable JSON snapshot. Returns the complete bundle JSON including templates, scripts, bindings, and policy.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("App/project ID to export")
                        ])
                    ]),
                    "required": .array([.string("app_id")])
                ])
            ),
            Tool(
                name: "bundle_import",
                description: "Import a bundle JSON snapshot into an app. Creates a new draft revision and optionally promotes it.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("Target app/project ID to import into")
                        ]),
                        "bundle_json": .object([
                            "type": .string("string"),
                            "description": .string("The bundle JSON snapshot to import")
                        ]),
                        "promote": .object([
                            "type": .string("boolean"),
                            "description": .string("Whether to auto-promote after import (default: false)")
                        ])
                    ]),
                    "required": .array([.string("app_id"), .string("bundle_json")])
                ])
            ),
            Tool(
                name: "bundle_clone",
                description: "Clone an app bundle to a new app_id. Copies all templates, scripts, bindings, and policy to the target.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "source_app_id": .object([
                            "type": .string("string"),
                            "description": .string("Source app/project ID to clone from")
                        ]),
                        "target_app_id": .object([
                            "type": .string("string"),
                            "description": .string("Target app/project ID to clone into")
                        ])
                    ]),
                    "required": .array([.string("source_app_id"), .string("target_app_id")])
                ])
            ),
            
            // MARK: - User Collaboration Tools
            
            Tool(
                name: "ask_user",
                description: "Ask the user a question and wait for their response. Use this to get feedback, request confirmation, or present choices. The agent will block until the user responds.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "type": .object([
                            "type": .string("string"),
                            "description": .string("Type of question: 'confirm' (yes/no), 'choose' (pick from options), 'text' (free-form input), 'plan' (show plan for approval)"),
                            "enum": .array([.string("confirm"), .string("choose"), .string("text"), .string("plan")])
                        ]),
                        "prompt": .object([
                            "type": .string("string"),
                            "description": .string("The question or message to show the user. Supports markdown for 'plan' type.")
                        ]),
                        "options": .object([
                            "type": .string("array"),
                            "description": .string("Options for 'choose' type. Each string becomes a button."),
                            "items": .object(["type": .string("string")])
                        ])
                    ]),
                    "required": .array([.string("type"), .string("prompt")])
                ])
            )
        ]
    }
    
    // MARK: - Tool Execution
    
    func handleToolCall(name: String, arguments: Value?) async -> CallTool.Result {
        if [
            "bundle_get", "bundle_put", "bundle_patch", "bundle_run",
            "bundle_run_status", "bundle_repair_trace", "bundle_export",
            "bundle_import", "bundle_clone"
        ].contains(name), !isBundleModeEnabled() {
            return .init(
                content: [.text("{\"error\": \"App Bundle Mode is disabled. Enable it in Settings > Developer.\"}")],
                isError: true
            )
        }

        switch name {
        case "get_location":
            return executeGetLocation()
        case "request_authorization":
            return await executeRequestAuthorization(arguments: arguments)
        case "ask_user":
            return await executeAskUser(arguments: arguments)
        case "save_script":
            return executeSaveScript(arguments: arguments)
        case "list_scripts":
            return executeListScripts(arguments: arguments)
        case "get_script":
            return executeGetScript(arguments: arguments)
        case "run_script":
            return await executeRunScript(arguments: arguments)
        case "bundle_get", "bundle_put", "bundle_patch", "bundle_run", "bundle_run_status", "bundle_repair_trace",
             "bundle_export", "bundle_import", "bundle_clone":
            switch name {
            case "bundle_get":
                return executeBundleGet(arguments: arguments)
            case "bundle_put":
                return executeBundlePut(arguments: arguments)
            case "bundle_patch":
                return executeBundlePatch(arguments: arguments)
            case "bundle_run":
                return await executeBundleRun(arguments: arguments)
            case "bundle_run_status":
                return executeBundleRunStatus(arguments: arguments)
            case "bundle_repair_trace":
                return executeBundleRepairTrace(arguments: arguments)
            case "bundle_export":
                return executeBundleExport(arguments: arguments)
            case "bundle_import":
                return executeBundleImport(arguments: arguments)
            case "bundle_clone":
                return executeBundleClone(arguments: arguments)
            default:
                break
            }
        default:
            break
        }

        var params: [String: Any] = ["name": name]
        if let arguments,
           case .object(let dict) = arguments {
            params["arguments"] = dict.mapValues { jsonToAny($0) }
        }

        let resultDict = handleJSONRPCMethodSync(method: "tools/call", params: params)
        return dictToCallToolResult(resultDict)
    }

    private func isBundleModeEnabled() -> Bool {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: "bundleMode") == nil {
            return true
        }
        return defaults.bool(forKey: "bundleMode")
    }
    

    
    // MARK: - Script Lifecycle Handlers
    
    // MARK: - User Collaboration Handler
    
    private func executeAskUser(arguments: Value?) async -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let typeVal = dict["type"], case .string(let askType) = typeVal,
              let promptVal = dict["prompt"], case .string(let prompt) = promptVal else {
            return .init(content: [.text("Missing required parameters: type, prompt")], isError: true)
        }
        
        var options: [String]? = nil
        if let optionsVal = dict["options"], case .array(let optionsArray) = optionsVal {
            options = optionsArray.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
        }
        
        let requestId = UUID().uuidString
        
        // Suspend until the user responds
        let userResponse = await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
            askUserLock.lock()
            askUserContinuations[requestId] = continuation
            askUserLock.unlock()
            onAskUser?(requestId, askType, prompt, options)
        }
        
        return .init(content: [.text(userResponse)], isError: false)
    }
    
    // MARK: - Script Lifecycle Handlers
    
    private func executeSaveScript(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let nameVal = dict["name"], case .string(let name) = nameVal,
              let sourceVal = dict["source"], case .string(let source) = sourceVal,
              let appIdVal = dict["app_id"], case .string(let appId) = appIdVal else {
            return .init(content: [.text("Missing required parameters: name, source, app_id")], isError: true)
        }
        
        var description: String? = nil
        if let descVal = dict["description"], case .string(let d) = descVal {
            description = d
        }

        var appName: String? = nil
        if let appNameVal = dict["app_name"], case .string(let providedAppName) = appNameVal {
            appName = providedAppName
        }

        var appSummary: String? = nil
        if let appSummaryVal = dict["app_summary"], case .string(let providedSummary) = appSummaryVal {
            appSummary = providedSummary
        }
        
        var capabilities: [String] = []
        if let permsVal = dict["permissions"], case .array(let permsArray) = permsVal {
            capabilities = permsArray.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
        }
        
        var version = "1.0.0"
        if let versionVal = dict["version"], case .string(let v) = versionVal {
            version = v
        }
        
        do {
            _ = try DatabaseManager.shared.ensureProject(
                id: appId,
                preferredName: appName,
                summary: appSummary
            )
            let repo = AppBundleRepository()
            let record = try repo.saveAppScript(
                appId: appId,
                name: name,
                source: source,
                description: description,
                capabilities: capabilities,
                version: version
            )
            let path = DatabaseManager.appScriptSandboxPath(appId: appId, name: name)
            let result: [String: Any] = [
                "id": record.id,
                "name": name,
                "app_id": appId,
                "path": path,
                "version": version
            ]
            if let jsonData = try? JSONSerialization.data(withJSONObject: result),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                return .init(content: [.text(jsonString)], isError: false)
            }
            return .init(content: [.text("{\"id\":\"\(record.id)\",\"name\":\"\(name)\"}")], isError: false)
        } catch {
            Log.mcp.error("save_script failed: \(error)")
            return .init(content: [.text("save_script error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    private func executeListScripts(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let appIdVal = dict["app_id"], case .string(let appId) = appIdVal else {
            return .init(content: [.text("Missing required parameter: app_id")], isError: true)
        }
        
        do {
            let repo = AppBundleRepository()
            let scripts = try repo.listAppScripts(appId: appId)
            let entries: [[String: Any]] = scripts.map { script in
                var entry: [String: Any] = [
                    "name": script.name,
                    "version": script.version,
                    "app_id": script.appId,
                    "path": DatabaseManager.appScriptSandboxPath(appId: appId, name: script.name)
                ]
                if let desc = script.description { entry["description"] = desc }
                if !script.requiredCapabilities.isEmpty { entry["capabilities"] = script.requiredCapabilities }
                return entry
            }
            if let jsonData = try? JSONSerialization.data(withJSONObject: entries),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                return .init(content: [.text(jsonString)], isError: false)
            }
            return .init(content: [.text("[]")], isError: false)
        } catch {
            Log.mcp.error("list_scripts failed: \(error)")
            return .init(content: [.text("list_scripts error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    private func executeGetScript(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let nameVal = dict["name"], case .string(let name) = nameVal,
              let appIdVal = dict["app_id"], case .string(let appId) = appIdVal else {
            return .init(content: [.text("Missing required parameters: name, app_id")], isError: true)
        }
        
        do {
            let repo = AppBundleRepository()
            guard let script = try repo.getAppScript(appId: appId, name: name) else {
                return .init(content: [.text("{\"error\": \"Script '\(name)' not found for app '\(appId)'\"}")], isError: true)
            }
            var result: [String: Any] = [
                "name": script.name,
                "source": script.source,
                "version": script.version,
                "app_id": script.appId,
                "path": DatabaseManager.appScriptSandboxPath(appId: appId, name: script.name)
            ]
            if let desc = script.description { result["description"] = desc }
            if !script.requiredCapabilities.isEmpty { result["capabilities"] = script.requiredCapabilities }
            
            if let jsonData = try? JSONSerialization.data(withJSONObject: result),
               let jsonString = String(data: jsonData, encoding: .utf8) {
                return .init(content: [.text(jsonString)], isError: false)
            }
            return .init(content: [.text("{\"error\": \"serialization failed\"}")], isError: true)
        } catch {
            Log.mcp.error("get_script failed: \(error)")
            return .init(content: [.text("get_script error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    private func executeRunScript(arguments: Value?) async -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let nameVal = dict["name"], case .string(let name) = nameVal,
              let appIdVal = dict["app_id"], case .string(let appId) = appIdVal else {
            return .init(content: [.text("Missing required parameters: name, app_id")], isError: true)
        }
        
        guard DatabaseManager.isValidScriptName(name) else {
            return .init(content: [.text("Invalid script name '\(name)'. Use kebab-case.")], isError: true)
        }
        
        // Verify script exists in app-scoped table
        do {
            let repo = AppBundleRepository()
            guard try repo.getAppScript(appId: appId, name: name) != nil else {
                return .init(content: [.text("{\"error\": \"Script '\(name)' not found for app '\(appId)'\"}")], isError: true)
            }
        } catch {
            return .init(content: [.text("run_script error: \(error.localizedDescription)")], isError: true)
        }
        
        var args: [String] = []
        if let argsVal = dict["args"], case .array(let argsArray) = argsVal {
            args = argsArray.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
        }
        
        let path = DatabaseManager.appScriptSandboxPath(appId: appId, name: name)
        let (success, output) = await ScriptExecutor.shared.evalFile(
            path: path,
            args: args,
            appId: appId,
            scriptName: name
        )
        
        if success {
            return .init(content: [.text(output ?? "{\"success\": true}")], isError: false)
        } else {
            return .init(content: [.text(output ?? "Script execution failed")], isError: true)
        }
    }
    
    // MARK: - Bundle Tool Handlers
    
    private func executeBundleGet(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let appIdVal = dict["app_id"], case .string(let appId) = appIdVal else {
            return .init(content: [.text("Missing required parameter: app_id")], isError: true)
        }
        
        do {
            let repo = AppBundleRepository()
            
            // If revision_id provided, fetch stored bundle JSON
            if let revIdVal = dict["revision_id"], case .string(let revisionId) = revIdVal {
                guard let revision = try repo.getBundleRevision(id: revisionId, appId: appId) else {
                    return .init(content: [.text("{\"error\": \"Revision '\(revisionId)' not found\"}")], isError: true)
                }
                return .init(content: [.text(revision.bundleJSON)], isError: false)
            }
            
            // Otherwise, build live bundle from current DB state
            let bundle = try AppBundle.build(appId: appId)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(bundle)
            guard let json = String(data: data, encoding: .utf8) else {
                return .init(content: [.text("{\"error\": \"Failed to encode bundle\"}")], isError: true)
            }
            return .init(content: [.text(json)], isError: false)
        } catch {
            Log.mcp.error("bundle_get failed: \(error)")
            return .init(content: [.text("bundle_get error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    private func executeBundlePut(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let appIdVal = dict["app_id"], case .string(let appId) = appIdVal,
              let bundleVal = dict["bundle_json"], case .string(let bundleJSON) = bundleVal,
              let modeVal = dict["mode"], case .string(let mode) = modeVal else {
            return .init(content: [.text("Missing required parameters: app_id, bundle_json, mode")], isError: true)
        }
        
        guard mode == "draft" || mode == "promote" else {
            return .init(content: [.text("Invalid mode '\(mode)'. Must be 'draft' or 'promote'.")], isError: true)
        }
        
        do {
            _ = try DatabaseManager.shared.ensureProject(id: appId)
            let repo = AppBundleRepository()
            
            // Validate the bundle JSON is parseable
            guard let jsonData = bundleJSON.data(using: .utf8) else {
                return .init(content: [.text("{\"error\": \"Invalid bundle JSON encoding\"}")], isError: true)
            }
            var bundle = try JSONDecoder().decode(AppBundle.self, from: jsonData)
            if bundle.manifest.appId != appId {
                bundle = bundle.retargeted(to: appId)
            }

            // Validate referential integrity before promote
            if mode == "promote", let validationErrors = bundle.validate() {
                return .init(content: [.text("{\"error\": \"validation_failed\", \"issues\": \(validationErrors)}")], isError: true)
            }

            let canonicalData = try JSONEncoder().encode(bundle)
            guard let canonicalBundleJSON = String(data: canonicalData, encoding: .utf8) else {
                return .init(content: [.text("{\"error\": \"Failed to encode bundle\"}")], isError: true)
            }

            // Save as draft first; if promote succeeds we'll mark it promoted.
            let revision = try repo.saveBundleRevision(
                appId: appId,
                status: .draft,
                summary: "Bundle \(mode) via bundle_put",
                bundleJSON: canonicalBundleJSON
            )
            
            // Promote if requested
            if mode == "promote" {
                // Restore the bundle contents into the app tables
                try bundle.restore(appId: appId)
                try repo.promoteBundleRevision(id: revision.id)
            }

            let finalStatus: BundleRevisionStatus = mode == "promote" ? .promoted : .draft
            
            let result: [String: Any] = [
                "revision_id": revision.id,
                "app_id": appId,
                "mode": mode,
                "status": finalStatus.rawValue
            ]
            if let resultData = try? JSONSerialization.data(withJSONObject: result),
               let resultStr = String(data: resultData, encoding: .utf8) {
                return .init(content: [.text(resultStr)], isError: false)
            }
            return .init(content: [.text("{\"revision_id\": \"\(revision.id)\"}")], isError: false)
        } catch {
            Log.mcp.error("bundle_put failed: \(error)")
            return .init(content: [.text("bundle_put error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    private func executeBundlePatch(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let appIdVal = dict["app_id"], case .string(let appId) = appIdVal,
              let patchesVal = dict["patches"], case .array(let patches) = patchesVal else {
            return .init(content: [.text("Missing required parameters: app_id, patches")], isError: true)
        }
        
        // Validate patch surfaces against repair policy
        let patchDicts: [[String: Any]] = patches.compactMap { patchVal in
            guard case .object(let p) = patchVal else { return nil }
            return p.reduce(into: [String: Any]()) { result, kv in
                result[kv.key] = jsonToAny(kv.value)
            }
        }
        if let bundle = try? AppBundle.build(appId: appId),
           let rejection = RepairCoordinator.validatePatchSurfaces(patches: patchDicts, policy: bundle.manifest.repairPolicy) {
            return .init(content: [.text("{\"error\": \"\(rejection)\"}")], isError: true)
        }
        
        do {
            _ = try DatabaseManager.shared.ensureProject(id: appId)
            let repo = AppBundleRepository()
            var applied = 0
            var errors: [String] = []
            
            for patchVal in patches {
                guard case .object(let patch) = patchVal,
                      let targetVal = patch["target"], case .string(let target) = targetVal,
                      let nameVal = patch["name"], case .string(let name) = nameVal,
                      let dataVal = patch["data"] else {
                    errors.append("Invalid patch format — requires target, name, data")
                    continue
                }
                
                let dataDict = jsonToDictionary(dataVal) ?? [:]
                
                switch target {
                case "template":
                    let template = jsonString(from: dataDict["template"]) ?? "{}"
                    let version = dataDict["version"] as? String ?? "1.0.0"
                    _ = try repo.saveAppTemplate(
                        appId: appId,
                        name: name,
                        version: version,
                        template: template,
                        defaultData: jsonString(from: dataDict["defaultData"]),
                        animation: jsonString(from: dataDict["animation"])
                    )
                    applied += 1
                    
                case "script":
                    let source = dataDict["source"] as? String ?? ""
                    let version = dataDict["version"] as? String ?? "1.0.0"
                    let capabilities: [String]
                    if let caps = dataDict["capabilities"] as? [String] {
                        capabilities = caps
                    } else if let capsAny = dataDict["capabilities"] as? [Any] {
                        capabilities = capsAny.compactMap { $0 as? String }
                    } else {
                        capabilities = []
                    }
                    _ = try repo.saveAppScript(
                        appId: appId,
                        name: name,
                        source: source,
                        description: dataDict["description"] as? String,
                        capabilities: capabilities,
                        version: version
                    )
                    applied += 1

                case "binding":
                    guard let templateName = dataDict["template"] as? String else {
                        errors.append("Binding patch '\(name)' missing required field 'template'")
                        continue
                    }
                    guard let componentPath = dataDict["componentPath"] as? String, !componentPath.isEmpty else {
                        errors.append("Binding patch '\(name)' missing required field 'componentPath'")
                        continue
                    }
                    let actionJSON = jsonString(from: dataDict["action"])
                        ?? (dataDict["actionJSON"] as? String)
                        ?? "{}"
                    _ = try repo.saveAppBinding(
                        appId: appId,
                        id: name,
                        template: templateName,
                        componentPath: componentPath,
                        actionJSON: actionJSON
                    )
                    applied += 1
                    
                default:
                    errors.append("Unknown patch target '\(target)'. Use 'template', 'script', or 'binding'.")
                }
            }
            
            var result: [String: Any] = ["applied": applied]
            if !errors.isEmpty { result["errors"] = errors }
            if let jsonData = try? JSONSerialization.data(withJSONObject: result),
               let jsonStr = String(data: jsonData, encoding: .utf8) {
                return .init(content: [.text(jsonStr)], isError: false)
            }
            return .init(content: [.text("{\"applied\": \(applied)}")], isError: false)
        } catch {
            Log.mcp.error("bundle_patch failed: \(error)")
            return .init(content: [.text("bundle_patch error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    private func executeBundleRun(arguments: Value?) async -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let appIdVal = dict["app_id"], case .string(let appId) = appIdVal,
              let entryVal = dict["entrypoint"], case .string(let entrypoint) = entryVal else {
            return .init(content: [.text("Missing required parameters: app_id, entrypoint")], isError: true)
        }
        
        let revisionId: String
        if let revIdVal = dict["revision_id"], case .string(let rid) = revIdVal {
            revisionId = rid
        } else {
            revisionId = "HEAD"
        }
        
        var args: [String] = []
        if let argsVal = dict["args"], case .array(let argsArray) = argsVal {
            args = argsArray.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
        }
        
        // Check for repair_for_run_id — repair loop integration
        let repairRunId: String?
        if let repairVal = dict["repair_for_run_id"], case .string(let rid) = repairVal {
            repairRunId = rid
        } else {
            repairRunId = nil
        }
        
        do {
            _ = try DatabaseManager.shared.ensureProject(id: appId)
            let repo = AppBundleRepository()
            
            // Verify script exists
            guard try repo.getAppScript(appId: appId, name: entrypoint) != nil else {
                return .init(content: [.text("{\"error\": \"Script '\(entrypoint)' not found for app '\(appId)'\"}")], isError: true)
            }
            if revisionId != "HEAD",
               try repo.getBundleRevision(id: revisionId, appId: appId) == nil {
                return .init(content: [.text("{\"error\": \"Revision '\(revisionId)' not found for app '\(appId)'\"}")], isError: true)
            }

            // If this is a repair attempt, enforce repair policy
            var repairAttemptNo: Int?
            if let repairRunId = repairRunId {
                guard UserDefaults.standard.bool(forKey: "bundleRepairMode") else {
                    return .init(content: [.text("{\"error\": \"Repair mode is disabled. Enable 'Bundle Repair Loop' in Settings.\"}")], isError: true)
                }
                guard let baseRun = try repo.getRun(id: repairRunId) else {
                    return .init(content: [.text("{\"error\": \"Repair run '\(repairRunId)' not found\"}")], isError: true)
                }
                guard baseRun.appId == appId else {
                    return .init(content: [.text("{\"error\": \"Repair run '\(repairRunId)' belongs to app '\(baseRun.appId)', not '\(appId)'\"}")], isError: true)
                }
                guard baseRun.status == .failed || baseRun.status == .repairing else {
                    return .init(content: [.text("{\"error\": \"Repair run '\(repairRunId)' has status '\(baseRun.status.rawValue)'. Only failed/repairing runs may be retried.\"}")], isError: true)
                }
                
                let bundle = try AppBundle.build(appId: appId)
                let coordinator = RepairCoordinator(
                    appId: appId,
                    runId: repairRunId,
                    policy: bundle.manifest.repairPolicy
                )
                
                if let denial = try coordinator.canRepair() {
                    try coordinator.abortAndRollback()
                    return .init(content: [.text("{\"error\": \"\(denial)\", \"action\": \"aborted_and_rolled_back\"}")], isError: true)
                }
                
                repairAttemptNo = try coordinator.recordAttempt(patchSummary: "retry entrypoint: \(entrypoint)")
            }
            
            // Create run record or reuse existing for repair
            let runId: String
            if let repairRunId = repairRunId {
                try repo.updateRunStatus(id: repairRunId, status: .running)
                runId = repairRunId
            } else {
                let run = try repo.saveRun(
                    appId: appId,
                    revisionId: revisionId,
                    entrypoint: entrypoint,
                    status: .running
                )
                runId = run.id
            }
            
            // Execute the script
            let path = DatabaseManager.appScriptSandboxPath(appId: appId, name: entrypoint)
            let (success, output) = await ScriptExecutor.shared.evalFile(path: path, args: args, appId: appId, scriptName: entrypoint)
            
            // Update run status
            let finalStatus: RunStatus = success ? .success : .failed
            let failureSig = success ? nil : (output ?? "Unknown error")
            try repo.updateRunStatus(id: runId, status: finalStatus, failureSignature: failureSig)
            if let attemptNo = repairAttemptNo {
                try repo.updateRepairAttempt(
                    runId: runId,
                    attemptNo: attemptNo,
                    outcome: success ? .success : .failed,
                    patchSummary: success ? "repair succeeded" : "repair failed: \(failureSig ?? "unknown")"
                )
            }
            
            var result: [String: Any] = [
                "run_id": runId,
                "app_id": appId,
                "status": finalStatus.rawValue,
                "entrypoint": entrypoint
            ]
            if let output = output { result["output"] = output }
            if repairRunId != nil { result["is_repair"] = true }
            
            if let jsonData = try? JSONSerialization.data(withJSONObject: result),
               let jsonStr = String(data: jsonData, encoding: .utf8) {
                return .init(content: [.text(jsonStr)], isError: !success)
            }
            return .init(content: [.text("{\"run_id\": \"\(runId)\", \"status\": \"\(finalStatus)\"}")], isError: !success)
        } catch {
            Log.mcp.error("bundle_run failed: \(error)")
            return .init(content: [.text("bundle_run error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    private func executeBundleRunStatus(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let runIdVal = dict["run_id"], case .string(let runId) = runIdVal else {
            return .init(content: [.text("Missing required parameter: run_id")], isError: true)
        }
        
        do {
            let repo = AppBundleRepository()
            guard let run = try repo.getRun(id: runId) else {
                return .init(content: [.text("{\"error\": \"Run '\(runId)' not found\"}")], isError: true)
            }
            
            let isoFormatter = ISO8601DateFormatter()
            var result: [String: Any] = [
                "run_id": run.id,
                "app_id": run.appId,
                "revision_id": run.revisionId,
                "entrypoint": run.entrypoint,
                "status": run.status.rawValue,
                "started_at": isoFormatter.string(from: run.startedAt)
            ]
            if let failSig = run.failureSignature { result["failure_signature"] = failSig }
            if let endedAt = run.endedAt { result["ended_at"] = isoFormatter.string(from: endedAt) }
            
            if let jsonData = try? JSONSerialization.data(withJSONObject: result),
               let jsonStr = String(data: jsonData, encoding: .utf8) {
                return .init(content: [.text(jsonStr)], isError: false)
            }
            return .init(content: [.text("{\"run_id\": \"\(runId)\", \"status\": \"\(run.status.rawValue)\"}")], isError: false)
        } catch {
            Log.mcp.error("bundle_run_status failed: \(error)")
            return .init(content: [.text("bundle_run_status error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    private func executeBundleRepairTrace(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let runIdVal = dict["run_id"], case .string(let runId) = runIdVal else {
            return .init(content: [.text("Missing required parameter: run_id")], isError: true)
        }
        
        do {
            let repo = AppBundleRepository()
            let attempts = try repo.listRepairAttempts(runId: runId)
            
            let isoFmt = ISO8601DateFormatter()
            let entries: [[String: Any]] = attempts.map { attempt in
                var entry: [String: Any] = [
                    "id": attempt.id,
                    "attempt_no": attempt.attemptNo,
                    "outcome": attempt.outcome.rawValue,
                    "started_at": isoFmt.string(from: attempt.startedAt)
                ]
                if let summary = attempt.patchSummary { entry["patch_summary"] = summary }
                if let endedAt = attempt.endedAt { entry["ended_at"] = isoFmt.string(from: endedAt) }
                return entry
            }
            
            let result: [String: Any] = [
                "run_id": runId,
                "attempts": entries,
                "count": entries.count
            ]
            if let jsonData = try? JSONSerialization.data(withJSONObject: result),
               let jsonStr = String(data: jsonData, encoding: .utf8) {
                return .init(content: [.text(jsonStr)], isError: false)
            }
            return .init(content: [.text("{\"run_id\": \"\(runId)\", \"count\": \(entries.count)}")], isError: false)
        } catch {
            Log.mcp.error("bundle_repair_trace failed: \(error)")
            return .init(content: [.text("bundle_repair_trace error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    // MARK: - Phase 5: Reuse Tools
    
    private func executeBundleExport(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let appIdVal = dict["app_id"], case .string(let appId) = appIdVal else {
            return .init(content: [.text("Missing required parameter: app_id")], isError: true)
        }
        
        do {
            let bundle = try AppBundle.build(appId: appId)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(bundle)
            guard let jsonStr = String(data: data, encoding: .utf8) else {
                return .init(content: [.text("{\"error\": \"Failed to encode bundle\"}")], isError: true)
            }
            
            let result: [String: Any] = [
                "app_id": appId,
                "templates_count": bundle.templates.count,
                "scripts_count": bundle.scripts.count,
                "bindings_count": bundle.bindings.count,
                "bundle_json": jsonStr
            ]
            if let resultData = try? JSONSerialization.data(withJSONObject: result),
               let resultStr = String(data: resultData, encoding: .utf8) {
                return .init(content: [.text(resultStr)], isError: false)
            }
            return .init(content: [.text(jsonStr)], isError: false)
        } catch {
            Log.mcp.error("bundle_export failed: \(error)")
            return .init(content: [.text("bundle_export error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    private func executeBundleImport(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let appIdVal = dict["app_id"], case .string(let appId) = appIdVal,
              let bundleVal = dict["bundle_json"], case .string(let bundleJSON) = bundleVal else {
            return .init(content: [.text("Missing required parameters: app_id, bundle_json")], isError: true)
        }
        
        let shouldPromote: Bool
        if let promoteVal = dict["promote"], case .bool(let p) = promoteVal {
            shouldPromote = p
        } else {
            shouldPromote = false
        }
        
        do {
            _ = try DatabaseManager.shared.ensureProject(id: appId)
            guard let jsonData = bundleJSON.data(using: .utf8) else {
                return .init(content: [.text("{\"error\": \"Invalid bundle JSON encoding\"}")], isError: true)
            }
            var bundle = try JSONDecoder().decode(AppBundle.self, from: jsonData)
            let sourceAppId = bundle.manifest.appId
            if sourceAppId != appId {
                bundle = bundle.retargeted(to: appId)
            }
            
            // Validate before import
            if let validationErrors = bundle.validate() {
                return .init(content: [.text("{\"error\": \"validation_failed\", \"issues\": \(validationErrors)}")], isError: true)
            }
            
            let repo = AppBundleRepository()
            let normalizedJSONData = try JSONEncoder().encode(bundle)
            let normalizedJSON = String(data: normalizedJSONData, encoding: .utf8) ?? bundleJSON
            let revision = try repo.saveBundleRevision(
                appId: appId,
                status: .draft,
                summary: "Imported bundle via bundle_import",
                bundleJSON: normalizedJSON
            )
            
            if shouldPromote {
                try bundle.restore(appId: appId)
                try repo.promoteBundleRevision(id: revision.id)
            }
            let finalStatus: BundleRevisionStatus = shouldPromote ? .promoted : .draft
            
            let result: [String: Any] = [
                "revision_id": revision.id,
                "app_id": appId,
                "source_app_id": sourceAppId,
                "status": finalStatus.rawValue,
                "promoted": shouldPromote,
                "templates_count": bundle.templates.count,
                "scripts_count": bundle.scripts.count,
                "bindings_count": bundle.bindings.count
            ]
            if let resultData = try? JSONSerialization.data(withJSONObject: result),
               let resultStr = String(data: resultData, encoding: .utf8) {
                return .init(content: [.text(resultStr)], isError: false)
            }
            return .init(content: [.text("{\"revision_id\": \"\(revision.id)\"}")], isError: false)
        } catch {
            Log.mcp.error("bundle_import failed: \(error)")
            return .init(content: [.text("bundle_import error: \(error.localizedDescription)")], isError: true)
        }
    }
    
    private func executeBundleClone(arguments: Value?) -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let srcVal = dict["source_app_id"], case .string(let sourceAppId) = srcVal,
              let tgtVal = dict["target_app_id"], case .string(let targetAppId) = tgtVal else {
            return .init(content: [.text("Missing required parameters: source_app_id, target_app_id")], isError: true)
        }
        
        do {
            if let sourceProject = try DatabaseManager.shared.getProject(id: sourceAppId) {
                _ = try DatabaseManager.shared.ensureProject(
                    id: targetAppId,
                    preferredName: "\(sourceProject.name) Copy",
                    summary: "Cloned from \(sourceAppId)"
                )
            } else {
                _ = try DatabaseManager.shared.ensureProject(
                    id: targetAppId,
                    summary: "Cloned from \(sourceAppId)"
                )
            }

            // Build snapshot from source
            let sourceBundle = try AppBundle.build(appId: sourceAppId)
            let bundle = sourceBundle.retargeted(to: targetAppId)
            
            // Restore into target
            try bundle.restore(appId: targetAppId)
            
            // Save and promote in target
            let encoder = JSONEncoder()
            let data = try encoder.encode(bundle)
            let bundleJSON = String(data: data, encoding: .utf8) ?? "{}"
            
            let repo = AppBundleRepository()
            let revision = try repo.saveBundleRevision(
                appId: targetAppId,
                status: .draft,
                summary: "Cloned from \(sourceAppId)",
                bundleJSON: bundleJSON
            )
            try repo.promoteBundleRevision(id: revision.id)
            
            let result: [String: Any] = [
                "source_app_id": sourceAppId,
                "target_app_id": targetAppId,
                "revision_id": revision.id,
                "templates_count": bundle.templates.count,
                "scripts_count": bundle.scripts.count,
                "bindings_count": bundle.bindings.count
            ]
            if let resultData = try? JSONSerialization.data(withJSONObject: result),
               let resultStr = String(data: resultData, encoding: .utf8) {
                return .init(content: [.text(resultStr)], isError: false)
            }
            return .init(content: [.text("{\"source\": \"\(sourceAppId)\", \"target\": \"\(targetAppId)\"}")], isError: false)
        } catch {
            Log.mcp.error("bundle_clone failed: \(error)")
            return .init(content: [.text("bundle_clone error: \(error.localizedDescription)")], isError: true)
        }
    }


    
    private func jsonToDictionary(_ json: Value) -> [String: Any]? {
        guard case .object(let dict) = json else { return nil }
        var result: [String: Any] = [:]
        for (key, value) in dict {
            result[key] = jsonToAny(value)
        }
        return result
    }
    
    private func jsonToAny(_ json: Value) -> Any {
        switch json {
        case .string(let s): return s
        case .int(let n): return n
        case .double(let n): return n
        case .bool(let b): return b
        case .null: return NSNull()
        case .array(let arr): return arr.map { jsonToAny($0) }
        case .object(let dict):
            var result: [String: Any] = [:]
            for (k, v) in dict { result[k] = jsonToAny(v) }
            return result
        case .data(_, let d): return d
        }
    }

    private func jsonString(from value: Any?) -> String? {
        guard let value else { return nil }
        if let str = value as? String {
            return str
        }
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let json = String(data: data, encoding: .utf8) else {
            return nil
        }
        return json
    }
    
    private func executeGetLocation() -> CallTool.Result {
        // Check authorization status first
        let status = locationManager.authorizationStatus
        
        switch status {
        case .notDetermined:
            // Request permission - iOS will show system dialog
            locationManager.requestWhenInUseAuthorization()
            return .init(
                content: [.text("""
                {"status": "permission_required", "message": "Location permission is being requested. Please ask the user to allow location access when the system dialog appears, then try again."}
                """)],
                isError: false  // Not an error, just a pending state
            )
            
        case .denied, .restricted:
            return .init(
                content: [.text("""
                {"status": "permission_denied", "message": "Location access is not available. The user has denied location permission or it is restricted. Use render_ui to show a message asking them to enable location in Settings."}
                """)],
                isError: true
            )
            
        case .authorizedWhenInUse, .authorizedAlways:
            guard let location = lastLocation else {
                // Permission granted but no location yet - request one
                locationManager.requestLocation()
                return .init(
                    content: [.text("""
                    {"status": "acquiring", "message": "Location permission granted. Acquiring GPS coordinates - please try again in a moment."}
                    """)],
                    isError: false
                )
            }
            
            // Success - return coordinates
            return .init(
                content: [.text("""
                {"status": "success", "lat": \(location.coordinate.latitude), "lon": \(location.coordinate.longitude)}
                """)],
                isError: false
            )
            
        @unknown default:
            return .init(
                content: [.text("{\"status\": \"unknown\", \"message\": \"Unknown authorization status\"}")],
                isError: true
            )
        }
    }
    
    // MARK: - Authorization Request
    
    private var authorizationContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
    
    private func executeRequestAuthorization(arguments: Value?) async -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let capabilityValue = dict["capability"],
              case .string(let capability) = capabilityValue else {
            return .init(content: [.text("{\"error\": \"Missing 'capability' parameter\"}")], isError: true)
        }
        
        switch capability {
        case "location":
            return await requestLocationAuthorization()
        case "bluetooth":
            return .init(content: [.text("{\"granted\": false, \"status\": \"not_implemented\", \"message\": \"Bluetooth authorization not yet implemented\"}")], isError: false)
        case "camera":
            return .init(content: [.text("{\"granted\": false, \"status\": \"not_implemented\", \"message\": \"Camera authorization not yet implemented\"}")], isError: false)
        case "microphone":
            return .init(content: [.text("{\"granted\": false, \"status\": \"not_implemented\", \"message\": \"Microphone authorization not yet implemented\"}")], isError: false)
        case "photos":
            return .init(content: [.text("{\"granted\": false, \"status\": \"not_implemented\", \"message\": \"Photos authorization not yet implemented\"}")], isError: false)
        default:
            return .init(content: [.text("{\"error\": \"Unknown capability: \(capability)\"}")], isError: true)
        }
    }
    
    private func requestLocationAuthorization() async -> CallTool.Result {
        let currentStatus = locationManager.authorizationStatus
        
        // Already authorized
        if currentStatus == .authorizedWhenInUse || currentStatus == .authorizedAlways {
            return .init(
                content: [.text("{\"granted\": true, \"status\": \"authorized\"}")],
                isError: false
            )
        }
        
        // Already denied
        if currentStatus == .denied || currentStatus == .restricted {
            return .init(
                content: [.text("{\"granted\": false, \"status\": \"denied\", \"message\": \"User has denied location access. They need to enable it in Settings.\"}")],
                isError: false
            )
        }
        
        // Not determined - request and wait for result
        let newStatus = await withCheckedContinuation { continuation in
            self.authorizationContinuation = continuation
            self.locationManager.requestWhenInUseAuthorization()
        }
        
        let granted = (newStatus == .authorizedWhenInUse || newStatus == .authorizedAlways)
        let statusString = granted ? "authorized" : "denied"
        
        return .init(
            content: [.text("{\"granted\": \(granted), \"status\": \"\(statusString)\"}")],
            isError: false
        )
    }
    
    // MARK: - HTTP Server (Network.framework)
    
    private func startHTTPServer() async throws {
        let parameters = NWParameters.tcp
        listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        
        listener?.stateUpdateHandler = { state in
            switch state {
            case .ready:
                Log.mcp.info(" HTTP listener ready")
            case .failed(let error):
                Log.mcp.info(" HTTP listener failed: \(error)")
            default:
                break
            }
        }
        
        listener?.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }
        
        listener?.start(queue: httpQueue)
    }
    
    private nonisolated func handleConnection(_ connection: NWConnection) {
        let connectionId = UUID().uuidString.prefix(8)
        Log.mcp.debug("[\(connectionId)] New connection accepted")
        
        connection.start(queue: httpQueue)
        let handler = MCPConnectionHandler(connection: connection, server: self, queue: httpQueue, connectionId: String(connectionId))
        handler.readMore()
    }
    
    /// Synchronous HTTP request handler - runs on httpQueue without MainActor hop
    fileprivate nonisolated func handleHTTPRequestSync(_ data: Data) -> Data {
        // Parse HTTP request body (skip headers for simplicity)
        guard let requestString = String(data: data, encoding: .utf8) else {
            Log.mcp.info(" Failed to decode request as UTF-8")
            return httpResponseSync(status: 400, body: "{\"error\": \"Invalid request encoding\"}")
        }
        
        Log.mcp.debug(" Received request (\(data.count) bytes)")
        
        guard let bodyStart = requestString.range(of: "\r\n\r\n")?.upperBound else {
            Log.mcp.info(" No header/body separator found")
            return httpResponseSync(status: 400, body: "{\"error\": \"Invalid request format\"}")
        }
        
        let body = String(requestString[bodyStart...])
        Log.mcp.info(" Body: \(body.prefix(200))")
        
        guard !body.isEmpty else {
            Log.mcp.info(" Empty body")
            return httpResponseSync(status: 400, body: "{\"error\": \"Empty body\"}")
        }
        
        guard let jsonData = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            Log.mcp.info(" JSON parse failed for body: \(body)")
            return httpResponseSync(status: 400, body: "{\"error\": \"Invalid JSON\"}")
        }
        
        // Handle JSON-RPC request
        let method = json["method"] as? String ?? ""
        let id = json["id"]
        let params = json["params"] as? [String: Any] ?? [:]
        
        let result = handleJSONRPCMethodSync(method: method, params: params)
        
        let responseJSON: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id ?? NSNull(),
            "result": result
        ]
        
        if let responseData = try? JSONSerialization.data(withJSONObject: responseJSON),
           let responseBody = String(data: responseData, encoding: .utf8) {
            Log.mcp.debug(" Sending response: \(responseBody.prefix(200))")
            return httpResponseSync(status: 200, body: responseBody)
        }
        
        return httpResponseSync(status: 500, body: "{\"error\": \"Serialization failed\"}")
    }
    
    /// Synchronous JSON-RPC method handler for methods that don't need MainActor
    private nonisolated func handleJSONRPCMethodSync(method: String, params: [String: Any]) -> [String: Any] {
        switch method {
        case "initialize":
            return [
                "protocolVersion": "2024-11-05",
                "capabilities": ["tools": [:]],
                "serverInfo": ["name": "ios-tools", "version": "1.0.0"]
            ]
        case "tools/list":
            // toolDefinitions is nonisolated, so we can access it directly
            return ["tools": toolDefinitions.map { toolToDictSync($0) }]
        case "tools/call":
            // For tool calls that update UI, dispatch to main queue without blocking
            // IMPORTANT: Do NOT use semaphore.wait() with MainActor - causes deadlock when WASM is running
            let name = params["name"] as? String ?? ""
            let argsData = params["arguments"] as? [String: Any]
            
            Log.mcp.debug(" tools/call: name=\(name)")
            
            switch name {
            case "get_location":
                if Thread.isMainThread {
                    nonisolated(unsafe) var locationResult: [String: Any] = [:]
                    MainActor.assumeIsolated {
                        let result = self.executeGetLocation()
                        locationResult = self.resultToDict(result)
                    }
                    return locationResult
                }

                let semaphore = DispatchSemaphore(value: 0)
                let responseBox = UnsafeBox<[String: Any]>([
                    "content": [["type": "text", "text": "{\"error\": \"get_location unavailable\"}"]],
                    "isError": true,
                ])
                DispatchQueue.main.async {
                    let result = self.executeGetLocation()
                    responseBox.value = self.resultToDict(result)
                    semaphore.signal()
                }
                if semaphore.wait(timeout: .now() + 5.0) == .timedOut {
                    return ["content": [["type": "text", "text": "{\"error\": \"get_location timed out\"}"]], "isError": true]
                }
                return responseBox.value

            case "request_authorization":
                guard let capability = argsData?["capability"] as? String else {
                    return ["content": [["type": "text", "text": "{\"error\": \"Missing 'capability' parameter\"}"]], "isError": true]
                }
                if capability == "location" {
                    return ["content": [["type": "text", "text": "{\"granted\": false, \"status\": \"permission_required\", \"message\": \"Use get_location to trigger iOS permission prompt in the current runtime path.\"}"]], "isError": false]
                }
                return ["content": [["type": "text", "text": "{\"granted\": false, \"status\": \"not_implemented\", \"message\": \"Authorization for \(capability) is not implemented.\"}"]], "isError": false]
                

                
            case "ask_user":
                // Block httpQueue until user responds via MainActor.
                // Safe because: WASM is single-threaded (no concurrent requests during wait)
                // and resolution path only needs MainActor (which is free).
                dispatchPrecondition(condition: .notOnQueue(.main))
                
                guard let askType = argsData?["type"] as? String,
                      let prompt = argsData?["prompt"] as? String else {
                    return ["content": [["type": "text", "text": "Missing required parameters: type, prompt"]], "isError": true]
                }
                let options = argsData?["options"] as? [String]
                let requestId = UUID().uuidString
                let semaphore = DispatchSemaphore(value: 0)
                
                // Store semaphore BEFORE dispatching UI (ordering guarantee)
                askUserLock.lock()
                askUserSemaphores[requestId] = semaphore
                askUserLock.unlock()
                
                Log.mcp.info("[ask_user] Blocking httpQueue for requestId=\(requestId), prompt=\(prompt.prefix(80))")
                
                // Show ask_user UI on MainActor
                DispatchQueue.main.async { [weak self] in
                    self?.onAskUser?(requestId, askType, prompt, options)
                }
                
                // Block until user responds (up to 5 minutes)
                let waitResult = semaphore.wait(timeout: .now() + 300)
                
                // Read and clean up response
                askUserLock.lock()
                let userResponse = askUserResponses.removeValue(forKey: requestId)
                askUserSemaphores.removeValue(forKey: requestId)
                askUserLock.unlock()
                
                if waitResult == .timedOut || userResponse == nil {
                    Log.mcp.warning("[ask_user] Timed out waiting for user response (requestId=\(requestId))")
                    return ["content": [["type": "text", "text": "{\"error\": \"ask_user timed out after 5 minutes\"}"]], "isError": true]
                }
                
                Log.mcp.info("[ask_user] Got response for requestId=\(requestId)")
                return ["content": [["type": "text", "text": userResponse!]], "isError": false]
                
            default:
                if toolDefinitions.contains(where: { $0.name == name }) {
                    return executeToolCallSyncViaMainActor(name: name, argsData: argsData)
                }
                return ["content": [["type": "text", "text": "Unknown tool: \(name)"]], "isError": true]
            }
        default:
            return [:]
        }
    }
    
    /// Forward a synchronous legacy HTTP tool call to the primary async tool dispatcher.
    /// This keeps `tools/list` and `tools/call` behavior aligned for real MCP clients.
    private nonisolated func executeToolCallSyncViaMainActor(name: String, argsData: [String: Any]?) -> [String: Any] {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let argsPayload = argsData.flatMap { args -> Data? in
            guard JSONSerialization.isValidJSONObject(args) else { return nil }
            return try? JSONSerialization.data(withJSONObject: args)
        }
        
        let semaphore = DispatchSemaphore(value: 0)
        let responseBox = UnsafeBox<[String: Any]>([
            "content": [["type": "text", "text": "{\"error\": \"\(name) unavailable\"}"]],
            "isError": true,
        ])
        
        Task { @MainActor [weak self, argsPayload] in
            guard let self else {
                responseBox.value = ["content": [["type": "text", "text": "{\"error\": \"server unavailable\"}"]], "isError": true]
                semaphore.signal()
                return
            }
            let argsJSON: Value?
            if let argsPayload,
               let parsed = try? JSONSerialization.jsonObject(with: argsPayload) as? [String: Any] {
                argsJSON = self.dictToJSON(parsed)
            } else {
                argsJSON = nil
            }
            let result = await self.handleToolCall(name: name, arguments: argsJSON)
            responseBox.value = self.resultToDict(result)
            semaphore.signal()
        }
        
        if semaphore.wait(timeout: .now() + 300) == .timedOut {
            return ["content": [["type": "text", "text": "{\"error\": \"\(name) timed out\"}"]], "isError": true]
        }
        
        return responseBox.value
    }
    
    /// Nonisolated version of httpResponse
    fileprivate nonisolated func httpResponseSync(status: Int, body: String) -> Data {
        let response = """
        HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r
        Content-Type: application/json\r
        Content-Length: \(body.utf8.count)\r
        Access-Control-Allow-Origin: *\r
        \r
        \(body)
        """
        return Data(response.utf8)
    }
    
    /// Nonisolated tool dict conversion
    private nonisolated func toolToDictSync(_ tool: Tool) -> [String: Any] {
        var dict: [String: Any] = [
            "name": tool.name,
            "description": tool.description ?? ""
        ]
        // inputSchema is not optional in MCP SDK
        dict["inputSchema"] = valueToDictSync(tool.inputSchema)
        return dict
    }
    
    /// Nonisolated value conversion
    private nonisolated func valueToDictSync(_ value: Value) -> Any {
        switch value {
        case .string(let s): return s
        case .int(let i): return i
        case .double(let d): return d
        case .bool(let b): return b
        case .null: return NSNull()
        case .data(mimeType: let mimeType, let data):
            return data.dataURLEncoded(mimeType: mimeType)
        case .array(let arr): return arr.map { valueToDictSync($0) }
        case .object(let obj): return obj.mapValues { valueToDictSync($0) }
        @unknown default: return NSNull()
        }
    }
    
    private func handleHTTPRequest(_ data: Data) async -> Data {
        // Parse HTTP request body (skip headers for simplicity)
        guard let requestString = String(data: data, encoding: .utf8) else {
            Log.mcp.info(" Failed to decode request as UTF-8")
            return httpResponse(status: 400, body: "{\"error\": \"Invalid request encoding\"}")
        }
        
        Log.mcp.info(" Received request (\(data.count) bytes)")
        
        guard let bodyStart = requestString.range(of: "\r\n\r\n")?.upperBound else {
            Log.mcp.info(" No header/body separator found")
            Log.mcp.info(" Raw data: \(requestString.prefix(200))")
            return httpResponse(status: 400, body: "{\"error\": \"Invalid request format\"}")
        }
        
        let body = String(requestString[bodyStart...])
        Log.mcp.info(" Body: \(body.prefix(200))")
        
        guard !body.isEmpty else {
            Log.mcp.info(" Empty body")
            return httpResponse(status: 400, body: "{\"error\": \"Empty body\"}")
        }
        
        guard let jsonData = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            Log.mcp.info(" JSON parse failed for body: \(body)")
            return httpResponse(status: 400, body: "{\"error\": \"Invalid JSON\"}")
        }
        
        // Handle JSON-RPC request
        let method = json["method"] as? String ?? ""
        let id = json["id"]
        let params = json["params"] as? [String: Any] ?? [:]
        
        let result = await handleJSONRPCMethod(method: method, params: params)
        
        let responseJSON: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id ?? NSNull(),
            "result": result
        ]
        
        if let responseData = try? JSONSerialization.data(withJSONObject: responseJSON),
           let responseBody = String(data: responseData, encoding: .utf8) {
            return httpResponse(status: 200, body: responseBody)
        }
        
        return httpResponse(status: 500, body: "{\"error\": \"Serialization failed\"}")
    }
    
    private func handleJSONRPCMethod(method: String, params: [String: Any]) async -> [String: Any] {
        switch method {
        case "initialize":
            return [
                "protocolVersion": "2024-11-05",
                "capabilities": ["tools": [:]],
                "serverInfo": ["name": "ios-tools", "version": "1.0.0"]
            ]
        case "tools/list":
            return ["tools": toolDefinitions.map { toolToDict($0) }]
        case "tools/call":
            let name = params["name"] as? String ?? ""
            let args = params["arguments"] as? [String: Any]
            let argsJSON = args.map { dictToJSON($0) }
            let result = await handleToolCall(name: name, arguments: argsJSON)
            return resultToDict(result)
        default:
            return [:]
        }
    }
    
    // MARK: - Helper Methods
    
    private func httpResponse(status: Int, body: String) -> Data {
        let response = """
        HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r
        Content-Type: application/json\r
        Content-Length: \(body.utf8.count)\r
        Connection: close\r
        \r
        \(body)
        """
        return response.data(using: .utf8)!
    }
    
    private func toolToDict(_ tool: Tool) -> [String: Any] {
        ["name": tool.name, "description": tool.description ?? "", "inputSchema": valueToDictSync(tool.inputSchema)]
    }
    
    private func resultToDict(_ result: CallTool.Result) -> [String: Any] {
        var contents: [[String: Any]] = []
        for content in result.content {
            switch content {
            case .text(let text):
                contents.append(["type": "text", "text": text])
            case .image(data: let data, mimeType: let mimeType, metadata: let metadata):
                var item: [String: Any] = ["type": "image", "data": data, "mimeType": mimeType]
                if let metadata {
                    item["metadata"] = metadata
                }
                contents.append(item)
            case .audio(data: let data, mimeType: let mimeType):
                contents.append(["type": "audio", "data": data, "mimeType": mimeType])
            case .resource(uri: let uri, mimeType: let mimeType, text: let text):
                var item: [String: Any] = ["type": "resource", "uri": uri, "mimeType": mimeType]
                if let text {
                    item["text"] = text
                }
                contents.append(item)
            }
        }
        return ["content": contents, "isError": result.isError ?? false]
    }

    private func dictToCallToolResult(_ result: [String: Any]) -> CallTool.Result {
        var content: [Tool.Content] = []
        if let items = result["content"] as? [[String: Any]] {
            for item in items {
                let type = (item["type"] as? String) ?? "text"
                switch type {
                case "text":
                    if let text = item["text"] as? String {
                        content.append(.text(text))
                    }
                case "image":
                    if let data = item["data"] as? String,
                       let mimeType = item["mimeType"] as? String {
                        let metadata = item["metadata"] as? [String: String]
                        content.append(.image(data: data, mimeType: mimeType, metadata: metadata))
                    }
                case "audio":
                    if let data = item["data"] as? String,
                       let mimeType = item["mimeType"] as? String {
                        content.append(.audio(data: data, mimeType: mimeType))
                    }
                case "resource":
                    if let uri = item["uri"] as? String,
                       let mimeType = item["mimeType"] as? String {
                        let text = item["text"] as? String
                        content.append(.resource(uri: uri, mimeType: mimeType, text: text))
                    }
                default:
                    if let text = item["text"] as? String {
                        content.append(.text(text))
                    }
                }
            }
        }

        if content.isEmpty {
            content = [.text("Tool call failed")]
        }

        let isError = (result["isError"] as? Bool) ?? true
        return .init(content: content, isError: isError)
    }
    
    private func dictToJSON(_ dict: [String: Any]) -> Value {
        var result: [String: Value] = [:]
        for (key, value) in dict {
            result[key] = anyToJSON(value)
        }
        return .object(result)
    }
    
    private func anyToJSON(_ value: Any) -> Value {
        switch value {
        case let s as String: return .string(s)
        case let n as Double: return .double(n)
        case let n as Int: return .int(n)
        case let b as Bool: return .bool(b)
        case let arr as [Any]: return .array(arr.map { anyToJSON($0) })
        case let dict as [String: Any]: return dictToJSON(dict)
        default: return .null
        }
    }


    
    // MARK: - Location Services
    
    private func setupLocationManager() {
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyKilometer
    }
    
    func requestLocationPermission() {
        locationManager.requestWhenInUseAuthorization()
    }
}

// MARK: - MCP Connection Handler

/// Encapsulates per-connection state for MCPServer HTTP handling.
/// All access is serialized on the httpQueue, so the mutable buffer is safe.
private final class MCPConnectionHandler: @unchecked Sendable {
    private let connection: NWConnection
    private let server: MCPServer
    private let queue: DispatchQueue
    private let connectionId: String
    private var requestBuffer = Data()
    
    init(connection: NWConnection, server: MCPServer, queue: DispatchQueue, connectionId: String) {
        self.connection = connection
        self.server = server
        self.queue = queue
        self.connectionId = connectionId
    }
    
    func readMore() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, isComplete, error in
            if let error = error {
                Log.mcp.error("[\(connectionId)] Receive error: \(error)")
                connection.cancel()
                return
            }
            
            if let data = data {
                Log.mcp.debug("[\(connectionId)] Received \(data.count) bytes")
                requestBuffer.append(data)
            }
            
            if isComplete {
                Log.mcp.debug("[\(connectionId)] Connection closed by peer")
            }
            
            // Check if we have a complete HTTP request
            let headerSeparator = Data("\r\n\r\n".utf8)
            if let headerEndRange = requestBuffer.range(of: headerSeparator) {
                let headerData = requestBuffer[..<headerEndRange.lowerBound]
                
                // Parse Content-Length from headers (ASCII-safe)
                var contentLength = 0
                if let headersString = String(data: headerData, encoding: .utf8) {
                    for line in headersString.split(separator: "\r\n") {
                        if line.lowercased().hasPrefix("content-length:") {
                            let value = line.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)
                            contentLength = Int(value) ?? 0
                        }
                    }
                }
                
                // Calculate body length in BYTES (not characters!)
                let bodyStartIndex = headerEndRange.upperBound
                let currentBodyLength = requestBuffer.count - bodyStartIndex
                
                Log.mcp.debug("[\(connectionId)] Request check: Body \(currentBodyLength)/\(contentLength) bytes")
                
                // If we have the full body, process the request
                if currentBodyLength >= contentLength {
                    Log.mcp.debug("[\(connectionId)] Request complete, processing sync")
                    
                    let response = server.handleHTTPRequestSync(requestBuffer)
                    
                    Log.mcp.debug("[\(connectionId)] Sending \(response.count) bytes response")
                    connection.send(content: response, completion: .contentProcessed { error in
                        if let error = error {
                            Log.mcp.error("[\(self.connectionId)] Send error: \(error)")
                        } else {
                            Log.mcp.debug("[\(self.connectionId)] Sent response, closing connection")
                        }
                        self.connection.cancel()
                    })
                    return
                }
            }
            
            // Need more data or error
            if error != nil || isComplete {
                connection.cancel()
            } else {
                readMore()
            }
        }
    }
}

// MARK: - CLLocationManagerDelegate

extension MCPServer: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            lastLocation = locations.last
        }
    }
    
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Log.mcp.info(" Location error: \(error.localizedDescription)")
    }
    
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // Capture status before entering Task to avoid data race
        let status = manager.authorizationStatus
        Task { @MainActor in
            // Resume any waiting authorization request
            if let continuation = authorizationContinuation {
                authorizationContinuation = nil
                continuation.resume(returning: status)
            }
        }
    }
}
