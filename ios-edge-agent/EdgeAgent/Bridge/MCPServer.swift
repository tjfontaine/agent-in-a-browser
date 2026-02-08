import Foundation
import CoreLocation
import MCP
import Network
import OSLog
import WASIShims

// MARK: - SDUI Validation

/// Validates SDUI tool inputs to help the agent self-correct
struct SDUIValidator {
    
    /// Validation result containing warnings and/or errors
    struct ValidationResult {
        var errors: [String] = []
        var warnings: [String] = []
        
        var isValid: Bool { errors.isEmpty }
        
        var errorMessage: String? {
            guard !errors.isEmpty else { return nil }
            return "VALIDATION ERROR: " + errors.joined(separator: "; ")
        }
        
        var warningMessage: String? {
            guard !warnings.isEmpty else { return nil }
            return "⚠️ " + warnings.joined(separator: "; ")
        }
    }
    
    /// Validate a register_view template
    /// Checks that templates use ForEach for list rendering
    static func validateTemplate(_ component: [String: Any]) -> ValidationResult {
        var result = ValidationResult()
        
        // Check for ForEach in the component tree
        if !containsForEach(component) {
            result.warnings.append("Template has no ForEach component. For list rendering, use ForEach with items binding: {type: \"ForEach\", props: {items: \"{{items}}\", itemTemplate: {...}}}")
        }
        
        // Check for common mistakes - static children arrays with component objects
        if hasPrebuiltCardChildren(component) {
            result.errors.append("Template contains pre-built Card/Image components as children. Use ForEach with itemTemplate bindings instead of static children.")
        }
        
        return result
    }
    
    /// Validate show_view data
    /// Checks that data contains raw values, not component objects
    static func validateShowViewData(_ data: [String: Any]?) -> ValidationResult {
        var result = ValidationResult()
        
        guard let data = data else { return result }
        
        // Check each data value for component objects
        for (key, value) in data {
            if let array = value as? [[String: Any]] {
                for item in array {
                    if isComponentObject(item) {
                        result.errors.append("Data key '\(key)' contains component objects (found 'type' or 'props'). Pass raw data arrays instead, e.g. [{id: \"...\", title: \"...\"}]. ForEach itemTemplate will render each item.")
                        return result  // Return early - one error is enough
                    }
                }
            } else if let dict = value as? [String: Any], isComponentObject(dict) {
                result.errors.append("Data key '\(key)' contains a component object. Pass raw data values, not UI components.")
                return result
            }
        }
        
        return result
    }
    
    // MARK: - Helpers
    
    /// Recursively check if component tree contains ForEach
    private static func containsForEach(_ component: [String: Any]) -> Bool {
        if let type = component["type"] as? String, type == "ForEach" {
            return true
        }
        
        if let props = component["props"] as? [String: Any] {
            if let children = props["children"] as? [[String: Any]] {
                for child in children {
                    if containsForEach(child) {
                        return true
                    }
                }
            }
            // Check itemTemplate
            if let itemTemplate = props["itemTemplate"] as? [String: Any] {
                if containsForEach(itemTemplate) {
                    return true
                }
            }
            if let template = props["template"] as? [String: Any] {
                if containsForEach(template) {
                    return true
                }
            }
        }
        
        return false
    }
    
    /// Check if component has pre-built Card/Image children (common mistake)
    private static func hasPrebuiltCardChildren(_ component: [String: Any]) -> Bool {
        if let props = component["props"] as? [String: Any],
           let children = props["children"] as? [[String: Any]] {
            // Look for multiple Card or Image children with static URLs
            var cardCount = 0
            for child in children {
                if let type = child["type"] as? String, type == "Card" || type == "Image" {
                    if let childProps = child["props"] as? [String: Any] {
                        // Check if it has static (non-binding) values
                        if let url = childProps["url"] as? String, !url.contains("{{") {
                            cardCount += 1
                        }
                    }
                }
            }
            // If we have multiple static cards, it's a mistake
            if cardCount >= 2 {
                return true
            }
        }
        return false
    }
    
    /// Check if a dictionary looks like a component object
    private static func isComponentObject(_ dict: [String: Any]) -> Bool {
        // Components have "type" and usually "props"
        if dict["type"] is String && dict["props"] is [String: Any] {
            return true
        }
        return false
    }
}

// MARK: - iOS MCP Server

/// Local MCP server that provides iOS-specific tools to the headless agent.
/// Uses the official Swift MCP SDK with HTTPServerTransport.
///
/// Usage:
/// 1. Start server: `await MCPServer.shared.start()`
/// 2. Pass URL to agent config: `mcpServers: [{url: "http://localhost:9292"}]`
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
    
    // Render callback - called when agent invokes render_ui
    nonisolated(unsafe) var onRenderUI: (([[String: Any]]) -> Void)?
    
    // Update callback - called when agent invokes update_ui for partial updates
    nonisolated(unsafe) var onUpdateUI: (([[String: Any]]) -> Void)?
    
    // SDUI: Show view callback - called when agent invokes show_view (navigates to cached view)
    nonisolated(unsafe) var onShowView: ((String, [String: Any]?) -> Void)?
    
    // Ask user callback - called when agent invokes ask_user.
    // The closure receives (requestId, type, prompt, options) and must eventually call the response closure with the user's answer.
    nonisolated(unsafe) var onAskUser: ((_ requestId: String, _ type: String, _ prompt: String, _ options: [String]?) -> Void)?
    
    // Continuation for pending ask_user requests (keyed by requestId)
    private var askUserContinuations = [String: CheckedContinuation<String, Never>]()
    private let askUserLock = NSLock()
    
    // Deferred NWConnection responses for ask_user (legacy HTTP path)
    // Holds the connection open until the user responds, then sends the HTTP response.
    nonisolated(unsafe) var askUserDeferredConnections = [String: NWConnection]()
    
    /// Call this from the UI when the user responds to an ask_user request
    func resolveAskUser(requestId: String, response: String) {
        askUserLock.lock()
        let continuation = askUserContinuations.removeValue(forKey: requestId)
        let deferredConnection = askUserDeferredConnections.removeValue(forKey: requestId)
        askUserLock.unlock()
        
        // Resume async continuation (MCPServerKit path)
        continuation?.resume(returning: response)
        
        // Send deferred HTTP response (legacy HTTP path)
        if let connection = deferredConnection {
            let resultDict: [String: Any] = ["content": [["type": "text", "text": response]], "isError": false]
            let responseJSON: [String: Any] = [
                "jsonrpc": "2.0",
                "id": 1,
                "result": resultDict
            ]
            if let responseData = try? JSONSerialization.data(withJSONObject: responseJSON),
               let responseBody = String(data: responseData, encoding: .utf8) {
                let httpData = httpResponseSync(status: 200, body: responseBody)
                connection.send(content: httpData, completion: .contentProcessed { error in
                    if let error = error {
                        Log.mcp.error("[ask_user] Deferred send error: \(error)")
                    } else {
                        Log.mcp.info("[ask_user] Deferred response sent")
                    }
                    connection.cancel()
                })
            }
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
    
    private nonisolated var toolDefinitions: [Tool] {
        [
            Tool(
                name: "render_ui",
                description: "Display native iOS UI components. Pass an array of component specs with 'type' and 'props'. Each component can have a 'key' for updates. Supported types: VStack, HStack, Card, Text, Image, Icon, Badge, Button, Pressable, TextInput, Loading, Skeleton, ProgressBar, Toast.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "components": .object([
                            "type": .string("array"),
                            "description": .string("Array of {type, props} component specifications"),
                            "items": .object([
                                "type": .string("object")
                            ])
                        ])
                    ]),
                    "required": .array([.string("components")])
                ])
            ),
            Tool(
                name: "update_ui",
                description: "Partially update the UI by patching specific components by key. Use for streaming updates.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "patches": .object([
                            "type": .string("array"),
                            "description": .string("Array of patches: {key, op: 'replace'|'remove'|'update'|'append'|'prepend', component?, props?}"),
                            "items": .object([
                                "type": .string("object")
                            ])
                        ])
                    ]),
                    "required": .array([.string("patches")])
                ])
            ),
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
            
            // MARK: - View Registry Tools (SDUI)
            
            Tool(
                name: "register_view",
                description: "Register a reusable view template with data bindings. Templates use {{path}} for bindings. Once registered, use show_view to display.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "name": .object([
                            "type": .string("string"),
                            "description": .string("Unique name for the view template")
                        ]),
                        "version": .object([
                            "type": .string("string"),
                            "description": .string("Semver version for cache invalidation (e.g. '1.0.0')")
                        ]),
                        "component": .object([
                            "type": .string("object"),
                            "description": .string("The component tree with {{bindings}}")
                        ]),
                        "defaultData": .object([
                            "type": .string("object"),
                            "description": .string("Default data values for bindings")
                        ]),
                        "animation": .object([
                            "type": .string("object"),
                            "description": .string("Enter/exit animations: {enter, exit, duration}")
                        ]),
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("Optional app/project ID. When provided, also persists to app_templates for bundle tracking.")
                        ])
                    ]),
                    "required": .array([.string("name"), .string("version"), .string("component")])
                ])
            ),
            Tool(
                name: "show_view",
                description: "Navigate to a registered view with data. Bindings in the template are resolved with the provided data.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "name": .object([
                            "type": .string("string"),
                            "description": .string("Name of the registered view to show")
                        ]),
                        "data": .object([
                            "type": .string("object"),
                            "description": .string("Data to bind to template placeholders")
                        ])
                    ]),
                    "required": .array([.string("name")])
                ])
            ),
            Tool(
                name: "update_view_data",
                description: "Update data for the current view without re-registering the template.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "data": .object([
                            "type": .string("object"),
                            "description": .string("New data to merge with current view data")
                        ])
                    ]),
                    "required": .array([.string("data")])
                ])
            ),
            Tool(
                name: "update_template",
                description: "Apply patches to a registered template without full re-registration.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "name": .object([
                            "type": .string("string"),
                            "description": .string("Name of the view template to patch")
                        ]),
                        "patches": .object([
                            "type": .string("array"),
                            "description": .string("Array of patches: {path, value, op?}"),
                            "items": .object([
                                "type": .string("object")
                            ])
                        ]),
                        "app_id": .object([
                            "type": .string("string"),
                            "description": .string("Optional app/project ID. When provided, persist patched template to app_templates.")
                        ])
                    ]),
                    "required": .array([.string("name"), .string("patches")])
                ])
            ),
            Tool(
                name: "pop_view",
                description: "Pop the current view from the navigation stack and return to the previous view.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([:])
                ])
            ),
            Tool(
                name: "invalidate_view",
                description: "Remove a specific view from the cache, forcing re-registration on next use.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "name": .object([
                            "type": .string("string"),
                            "description": .string("Name of the view to invalidate")
                        ])
                    ]),
                    "required": .array([.string("name")])
                ])
            ),
            Tool(
                name: "invalidate_all_views",
                description: "Clear the entire view registry cache.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([:])
                ])
            ),
            Tool(
                name: "query_views",
                description: "Query registered view templates and navigation stack. Returns: templates (name, version), navigationStack (viewName, dataKeys), currentView. Use this to check if a template is already registered and what data is cached before re-fetching.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "name": .object([
                            "type": .string("string"),
                            "description": .string("Optional: query a specific template by name to get its full cached data")
                        ])
                    ])
                ])
            ),
            Tool(
                name: "sqlite_query",
                description: "Execute a SQL query on the SDUI database. Returns results as JSON array. Use for reading/writing app state, agent memory, and custom data tables.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "sql": .object([
                            "type": .string("string"),
                            "description": .string("SQL query to execute (SELECT/INSERT/UPDATE/DELETE)")
                        ]),
                        "params": .object([
                            "type": .string("array"),
                            "description": .string("Optional array of parameter values for ? placeholders"),
                            "items": .object([
                                "type": .string("string")
                            ])
                        ])
                    ]),
                    "required": .array([.string("sql")])
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
    
    private func handleToolCall(name: String, arguments: Value?) async -> CallTool.Result {
        switch name {
        case "render_ui":
            return await executeRenderUI(arguments: arguments)
        case "update_ui":
            return await executeUpdateUI(arguments: arguments)
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
    
    private func executeRenderUI(arguments: Value?) async -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let componentsJSON = dict["components"],
              case .array(let components) = componentsJSON else {
            return .init(content: [.text("Missing 'components' array")], isError: true)
        }
        
        // Convert JSON to dictionaries for Swift UI
        let componentDicts: [[String: Any]] = components.compactMap { json in
            jsonToDictionary(json)
        }
        
        // Dispatch to main thread for UI update
        await MainActor.run {
            onRenderUI?(componentDicts)
        }
        
        return .init(
            content: [.text("{\"rendered\": \(componentDicts.count)}")],
            isError: false
        )
    }
    
    private func executeUpdateUI(arguments: Value?) async -> CallTool.Result {
        guard let arguments = arguments,
              case .object(let dict) = arguments,
              let patchesJSON = dict["patches"],
              case .array(let patches) = patchesJSON else {
            return .init(content: [.text("Missing 'patches' array")], isError: true)
        }
        
        // Convert JSON to dictionaries for Swift UI
        let patchDicts: [[String: Any]] = patches.compactMap { json in
            jsonToDictionary(json)
        }
        
        // Dispatch to main thread for UI update
        await MainActor.run {
            onUpdateUI?(patchDicts)
        }
        
        return .init(
            content: [.text("{\"patched\": \(patchDicts.count)}")],
            isError: false
        )
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
        
        // Notify UI to show the ask_user card
        await MainActor.run {
            onAskUser?(requestId, askType, prompt, options)
        }
        
        // Suspend until the user responds
        let userResponse = await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
            askUserLock.lock()
            askUserContinuations[requestId] = continuation
            askUserLock.unlock()
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
        
        var capabilities: [String] = []
        if let permsVal = dict["permissions"], case .array(let permsArray) = permsVal {
            capabilities = permsArray.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
        }
        
        var version = "1.0.0"
        if let versionVal = dict["version"], case .string(let v) = versionVal {
            version = v
        }
        
        do {
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

    private func persistViewTemplateToAppScope(name: String, appId: String) throws {
        guard let template = ViewRegistry.shared.templates[name] else {
            throw NSError(
                domain: "MCPServer",
                code: 404,
                userInfo: [NSLocalizedDescriptionKey: "Template '\(name)' not found after patch"]
            )
        }

        var animationJSON: String? = nil
        if let animation = template.animation {
            let animationDict: [String: Any] = [
                "enter": animation.enter as Any,
                "exit": animation.exit as Any,
                "duration": animation.duration as Any
            ].compactMapValues { $0 }
            if let data = try? JSONSerialization.data(withJSONObject: animationDict) {
                animationJSON = String(data: data, encoding: .utf8)
            }
        }

        _ = try AppBundleRepository().saveAppTemplate(
            appId: appId,
            name: template.name,
            version: template.version,
            template: template.template,
            defaultData: template.defaultData,
            animation: animationJSON
        )
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
        
        // Buffer to accumulate request data
        var requestBuffer = Data()
        
        func readMore() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
                guard let self = self else {
                    Log.mcp.debug("[\(connectionId)] Server deallocated, cancelling connection")
                    connection.cancel()
                    return
                }
                
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
                    // If we have data, we might need to process it, but usually HTTP 1.1 doesn't close connection for request
                }
                
                // Check if we have a complete HTTP request
                // Use byte-based parsing to correctly handle Content-Length (which is in bytes, not characters)
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
                        
                        // Check if this is an ask_user tool call — needs deferred response
                        if self.tryDeferAskUser(requestData: requestBuffer, connection: connection, connectionId: String(connectionId)) {
                            return  // Connection held open; response sent later via resolveAskUser
                        }
                        
                        // Process synchronously on httpQueue to avoid latency
                        let response = self.handleHTTPRequestSync(requestBuffer)
                        
                        Log.mcp.debug("[\(connectionId)] Sending \(response.count) bytes response")
                        connection.send(content: response, completion: .contentProcessed { error in
                            if let error = error {
                                Log.mcp.error("[\(connectionId)] Send error: \(error)")
                            } else {
                                Log.mcp.debug("[\(connectionId)] Sent response, closing connection")
                            }
                            connection.cancel()
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
        
        readMore()
    }
    
    /// Detects ask_user tool calls and defers the HTTP response until the user answers.
    /// Returns true if this is an ask_user call (connection held open), false otherwise.
    private nonisolated func tryDeferAskUser(requestData: Data, connection: NWConnection, connectionId: String) -> Bool {
        guard let requestString = String(data: requestData, encoding: .utf8),
              let bodyStart = requestString.range(of: "\r\n\r\n")?.upperBound else {
            return false
        }
        
        let body = String(requestString[bodyStart...])
        guard let jsonData = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
              let params = json["params"] as? [String: Any],
              let toolName = params["name"] as? String,
              toolName == "ask_user" else {
            return false
        }
        
        let argsData = params["arguments"] as? [String: Any]
        guard let askType = argsData?["type"] as? String,
              let prompt = argsData?["prompt"] as? String else {
            return false
        }
        let options = argsData?["options"] as? [String]
        let requestId = UUID().uuidString
        
        Log.mcp.info("[\(connectionId)] ask_user detected — deferring response for requestId=\(requestId)")
        
        // Stash the connection for later response
        askUserLock.lock()
        askUserDeferredConnections[requestId] = connection
        askUserLock.unlock()
        
        // Notify UI on main thread
        DispatchQueue.main.async { [weak self] in
            self?.onAskUser?(requestId, askType, prompt, options)
        }
        
        return true  // Connection held open
    }
    
    /// Synchronous HTTP request handler - runs on httpQueue without MainActor hop
    private nonisolated func handleHTTPRequestSync(_ data: Data) -> Data {
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
            case "render_ui":
                // Extract components and dispatch to main queue (fire-and-forget for UI)
                if let components = argsData?["components"] as? [[String: Any]] {
                    DispatchQueue.main.async { [weak self] in
                        self?.onRenderUI?(components)
                    }
                    return ["content": [["type": "text", "text": "{\"rendered\": \(components.count)}"]], "isError": false]
                }
                return ["content": [["type": "text", "text": "Missing 'components' array"]], "isError": true]
                
            case "update_ui":
                // Extract patches and dispatch to main queue (fire-and-forget for UI)
                if let patches = argsData?["patches"] as? [[String: Any]] {
                    DispatchQueue.main.async { [weak self] in
                        self?.onUpdateUI?(patches)
                    }
                    return ["content": [["type": "text", "text": "{\"patched\": \(patches.count)}"]], "isError": false]
                }
                return ["content": [["type": "text", "text": "Missing 'patches' array"]], "isError": true]
                
            case "get_location":
                if Thread.isMainThread {
                    let result = MainActor.assumeIsolated {
                        self.executeGetLocation()
                    }
                    return MainActor.assumeIsolated {
                        self.resultToDict(result)
                    }
                }

                let semaphore = DispatchSemaphore(value: 0)
                var response: [String: Any] = [
                    "content": [["type": "text", "text": "{\"error\": \"get_location unavailable\"}"]],
                    "isError": true,
                ]
                DispatchQueue.main.async {
                    let result = self.executeGetLocation()
                    response = self.resultToDict(result)
                    semaphore.signal()
                }
                if semaphore.wait(timeout: .now() + 5.0) == .timedOut {
                    return ["content": [["type": "text", "text": "{\"error\": \"get_location timed out\"}"]], "isError": true]
                }
                return response

            case "request_authorization":
                guard let capability = argsData?["capability"] as? String else {
                    return ["content": [["type": "text", "text": "{\"error\": \"Missing 'capability' parameter\"}"]], "isError": true]
                }
                if capability == "location" {
                    return ["content": [["type": "text", "text": "{\"granted\": false, \"status\": \"permission_required\", \"message\": \"Use get_location to trigger iOS permission prompt in the current runtime path.\"}"]], "isError": false]
                }
                return ["content": [["type": "text", "text": "{\"granted\": false, \"status\": \"not_implemented\", \"message\": \"Authorization for \(capability) is not implemented.\"}"]], "isError": false]
                
            // MARK: - View Registry Tool Handlers
                
            case "register_view":
                guard let name = argsData?["name"] as? String,
                      let version = argsData?["version"] as? String,
                      let component = argsData?["component"] as? [String: Any] else {
                    return ["content": [["type": "text", "text": "Missing required parameters: name, version, component"]], "isError": true]
                }
                
                // Validate template structure
                let validation = SDUIValidator.validateTemplate(component)
                if let errorMsg = validation.errorMessage {
                    return ["content": [["type": "text", "text": errorMsg]], "isError": true]
                }
                
                let defaultData = argsData?["defaultData"] as? [String: Any]
                var animation: ViewAnimation? = nil
                if let animDict = argsData?["animation"] as? [String: Any] {
                    animation = ViewAnimation(
                        enter: animDict["enter"] as? String,
                        exit: animDict["exit"] as? String,
                        duration: animDict["duration"] as? Double
                    )
                }
                DispatchQueue.main.async {
                    do {
                        try ViewRegistry.shared.registerView(
                            name: name,
                            version: version,
                            template: component,
                            defaultData: defaultData,
                            animation: animation
                        )
                    } catch {
                        Log.mcp.error("register_view failed: \(error)")
                    }
                }
                
                // Also persist to app_templates when app_id is provided
                if let appId = argsData?["app_id"] as? String {
                    do {
                        let repo = AppBundleRepository()
                        let templateJSON = try JSONSerialization.data(withJSONObject: component)
                        let templateStr = String(data: templateJSON, encoding: .utf8) ?? "{}"
                        
                        var defaultDataStr: String? = nil
                        if let dd = defaultData {
                            let ddJSON = try JSONSerialization.data(withJSONObject: dd)
                            defaultDataStr = String(data: ddJSON, encoding: .utf8)
                        }
                        
                        var animationStr: String? = nil
                        if let anim = animation {
                            let animDict: [String: Any] = [
                                "enter": anim.enter as Any,
                                "exit": anim.exit as Any,
                                "duration": anim.duration as Any
                            ].compactMapValues { $0 }
                            let animJSON = try JSONSerialization.data(withJSONObject: animDict)
                            animationStr = String(data: animJSON, encoding: .utf8)
                        }
                        
                        _ = try repo.saveAppTemplate(
                            appId: appId,
                            name: name,
                            version: version,
                            template: templateStr,
                            defaultData: defaultDataStr,
                            animation: animationStr
                        )
                        Log.mcp.info("register_view: also persisted to app_templates for app \(appId)")
                    } catch {
                        Log.mcp.error("register_view: failed to persist to app_templates: \(error)")
                    }
                }
                
                // Include warning in response if present
                var responseText = "{\"registered\": \"\(name)\", \"version\": \"\(version)\"}"
                if let warningMsg = validation.warningMessage {
                    responseText = "{\"registered\": \"\(name)\", \"version\": \"\(version)\", \"warning\": \"\(warningMsg)\"}"
                }
                return ["content": [["type": "text", "text": responseText]], "isError": false]
                
            case "show_view":
                guard let name = argsData?["name"] as? String else {
                    return ["content": [["type": "text", "text": "Missing required parameter: name"]], "isError": true]
                }
                let data = argsData?["data"] as? [String: Any]
                
                // Validate data structure - must be raw data, not components
                let validation = SDUIValidator.validateShowViewData(data)
                if let errorMsg = validation.errorMessage {
                    return ["content": [["type": "text", "text": errorMsg]], "isError": true]
                }
                
                DispatchQueue.main.async { [weak self] in
                    do {
                        try ViewRegistry.shared.showView(name: name, data: data)
                        self?.onShowView?(name, data)
                    } catch {
                        Log.mcp.error("show_view failed: \(error)")
                    }
                }
                return ["content": [["type": "text", "text": "{\"showing\": \"\(name)\"}"]], "isError": false]
                
            case "update_view_data":
                guard let data = argsData?["data"] as? [String: Any] else {
                    return ["content": [["type": "text", "text": "Missing required parameter: data"]], "isError": true]
                }
                DispatchQueue.main.async {
                    do {
                        try ViewRegistry.shared.updateViewData(data: data)
                    } catch {
                        Log.mcp.error("update_view_data failed: \(error)")
                    }
                }
                return ["content": [["type": "text", "text": "{\"updated\": true}"]], "isError": false]
                
            case "update_template":
                guard let name = argsData?["name"] as? String,
                      let patches = argsData?["patches"] as? [[String: Any]] else {
                    return ["content": [["type": "text", "text": "Missing required parameters: name, patches"]], "isError": true]
                }
                let appId = argsData?["app_id"] as? String

                // Avoid deadlock when called from MainActor path
                if Thread.isMainThread {
                    do {
                        try MainActor.assumeIsolated {
                            try ViewRegistry.shared.updateTemplate(name: name, patches: patches)
                            if let appId {
                                try persistViewTemplateToAppScope(name: name, appId: appId)
                            }
                        }
                    } catch {
                        return ["content": [["type": "text", "text": "Template patch error: \(error.localizedDescription)"]], "isError": true]
                    }
                    return ["content": [["type": "text", "text": "{\"patched\": \"\(name)\", \"count\": \(patches.count)}"]], "isError": false]
                }

                let semaphore = DispatchSemaphore(value: 0)
                var patchError: String?
                DispatchQueue.main.async {
                    do {
                        try ViewRegistry.shared.updateTemplate(name: name, patches: patches)
                        if let appId {
                            try self.persistViewTemplateToAppScope(name: name, appId: appId)
                        }
                    } catch {
                        patchError = error.localizedDescription
                    }
                    semaphore.signal()
                }

                if semaphore.wait(timeout: .now() + 5.0) == .timedOut {
                    return ["content": [["type": "text", "text": "{\"error\": \"update_template timed out\"}"]], "isError": true]
                }
                if let patchError {
                    return ["content": [["type": "text", "text": "Template patch error: \(patchError)"]], "isError": true]
                }

                return ["content": [["type": "text", "text": "{\"patched\": \"\(name)\", \"count\": \(patches.count)}"]], "isError": false]
                
            case "pop_view":
                DispatchQueue.main.async {
                    _ = ViewRegistry.shared.popView()
                }
                return ["content": [["type": "text", "text": "{\"popped\": true}"]], "isError": false]
                
            case "invalidate_view":
                guard let name = argsData?["name"] as? String else {
                    return ["content": [["type": "text", "text": "Missing required parameter: name"]], "isError": true]
                }
                DispatchQueue.main.async {
                    ViewRegistry.shared.invalidateView(name: name)
                }
                return ["content": [["type": "text", "text": "{\"invalidated\": \"\(name)\"}"]], "isError": false]
                
            case "invalidate_all_views":
                DispatchQueue.main.async {
                    ViewRegistry.shared.invalidateAllViews()
                }
                return ["content": [["type": "text", "text": "{\"invalidated\": \"all\"}"]], "isError": false]
                
            case "query_views":
                // Query view registry state
                var result: [String: Any] = [:]

                if Thread.isMainThread {
                    result = MainActor.assumeIsolated {
                        buildQueryViewsResult(argsData: argsData)
                    }
                } else {
                    let semaphore = DispatchSemaphore(value: 0)
                    DispatchQueue.main.async {
                        result = MainActor.assumeIsolated {
                            self.buildQueryViewsResult(argsData: argsData)
                        }
                        semaphore.signal()
                    }

                    // Wait with timeout to prevent indefinite blocking
                    let waitResult = semaphore.wait(timeout: .now() + 5.0)
                    if waitResult == .timedOut {
                        return ["content": [["type": "text", "text": "{\"error\": \"query_views timed out\"}"]], "isError": true]
                    }
                }
                
                if let jsonData = try? JSONSerialization.data(withJSONObject: result),
                   let jsonString = String(data: jsonData, encoding: .utf8) {
                    return ["content": [["type": "text", "text": jsonString]], "isError": false]
                }
                return ["content": [["type": "text", "text": "{\"error\": \"serialization failed\"}"]], "isError": true]
                
            case "sqlite_query":
                guard let sql = argsData?["sql"] as? String else {
                    return ["content": [["type": "text", "text": "Missing required parameter: sql"]], "isError": true]
                }
                let params = argsData?["params"] as? [Any] ?? []
                
                do {
                    let results = try DatabaseManager.shared.executeQuery(sql: sql, params: params)
                    if let jsonData = try? JSONSerialization.data(withJSONObject: results),
                       let jsonString = String(data: jsonData, encoding: .utf8) {
                        return ["content": [["type": "text", "text": jsonString]], "isError": false]
                    }
                    return ["content": [["type": "text", "text": "{\"rows\": \(results.count)}"]], "isError": false]
                } catch {
                    Log.mcp.error("sqlite_query failed: \(error)")
                    return ["content": [["type": "text", "text": "Query error: \(error.localizedDescription)"]], "isError": true]
                }
                
            default:
                return ["content": [["type": "text", "text": "Unknown tool: \(name)"]], "isError": true]
            }
        default:
            return [:]
        }
    }
    
    /// Nonisolated version of httpResponse
    private nonisolated func httpResponseSync(status: Int, body: String) -> Data {
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

    @MainActor
    private func buildQueryViewsResult(argsData: [String: Any]?) -> [String: Any] {
        let registry = ViewRegistry.shared

        // If querying a specific view by name, return its cached data
        if let queryName = argsData?["name"] as? String {
            // Find data in navigation stack
            if let viewState = registry.navigationStack.first(where: { $0.viewName == queryName }) {
                let template = registry.templates[queryName]
                return [
                    "found": true,
                    "viewName": queryName,
                    "version": template?.version ?? "unknown",
                    "cachedData": viewState.data,
                    "inStack": true,
                ] as [String: Any]
            } else if let template = registry.templates[queryName] {
                // Template exists but not in stack (no data cached)
                return [
                    "found": true,
                    "viewName": queryName,
                    "version": template.version,
                    "inStack": false,
                    "defaultData": template.parseDefaultData() ?? [:],
                ] as [String: Any]
            } else {
                return ["found": false, "viewName": queryName] as [String: Any]
            }
        }

        // General query - list all templates and stack
        let templates = registry.templates.map { name, template in
            ["name": name, "version": template.version]
        }

        let stack = registry.navigationStack.map { state in
            [
                "viewName": state.viewName,
                "dataKeys": Array(state.data.keys),
            ] as [String: Any]
        }

        return [
            "templates": templates,
            "navigationStack": stack,
            "currentView": registry.currentView?.viewName ?? NSNull(),
            "stackDepth": registry.navigationStack.count,
        ] as [String: Any]
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
