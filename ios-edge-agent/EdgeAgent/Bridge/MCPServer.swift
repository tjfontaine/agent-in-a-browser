import Foundation
import CoreLocation
import MCP
import Network
import OSLog

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

    
    private override init() {
        super.init()
        Task { @MainActor in
            setupLocationManager()
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
        default:
            return .init(content: [.text("Unknown tool: \(name)")], isError: true)
        }
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
                // Location doesn't need MainActor, return directly
                return [
                    "content": [["type": "text", "text": "{\"status\": \"not_determined\", \"message\": \"Location requires permission\"}"]],
                    "isError": false
                ]
                
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
            if case .text(let text) = content {
                contents.append(["type": "text", "text": text])
            }
        }
        return ["content": contents, "isError": result.isError ?? false]
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
