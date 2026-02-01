import Foundation
import WasmKit
import WasmParser
import Combine
import OSLog

/// Native WASM runtime for the headless agent using WasmKit.
/// This provides proper async HTTP support via URLSession, avoiding the
/// WebView sync/async timing issues.
@MainActor
final class NativeAgentHost: NSObject, ObservableObject, @unchecked Sendable {
    
    static let shared = NativeAgentHost()
    
    // Published state for SwiftUI
    @Published var events: [AgentEvent] = []
    @Published var isReady = false
    @Published var currentStreamText = ""
    
    private var engine: Engine?
    private var store: Store?
    private var instance: Instance?
    
    // Current agent handle
    private var agentHandle: UInt32?
    
    // Resource registries for WASI handles
    private let resources = ResourceRegistry()
    
    // HTTP state management
    private let httpManager = HTTPRequestManager()
    
    private override init() {
        super.init()
    }
    
    // MARK: - Public API
    
    /// Load and initialize the WASM module
    func load() async throws {
        // Get path to WASM file in bundle - it's inside the WebRuntime folder
        guard let wasmPath = Bundle.main.path(forResource: "WebRuntime/web-headless-agent-sync/web-headless-agent-ios.core", ofType: "wasm") else {
            throw NativeAgentError.wasmNotFound
        }
        
        let wasmData = try Data(contentsOf: URL(fileURLWithPath: wasmPath))
        let module = try parseWasm(bytes: Array(wasmData))
        
        // Create engine and store
        engine = Engine()
        store = Store(engine: engine!)
        
        // Build imports for WASI interfaces
        var imports = Imports()
        registerWasiImports(&imports)
        registerHttpImports(&imports)
        registerIoImports(&imports)
        registerClocksImports(&imports)
        registerRandomImports(&imports)
        
        // Instantiate module
        instance = try module.instantiate(store: store!, imports: imports)
        
        Log.agent.info(" WASM module loaded successfully")
        isReady = true
    }
    
    /// Create a new agent with the given configuration (uses AgentConfig for compatibility)
    func createAgent(config: AgentConfig) {
        guard isReady, let instance = instance else {
            Log.agent.info(" Not ready, deferring agent creation")
            return
        }
        
        Task {
            do {
                let handle = try await createAgentInternal(config: config)
                self.agentHandle = UInt32(bitPattern: handle)
                Log.agent.info(" Agent created with handle: \(handle)")
            } catch {
                Log.agent.info(" Failed to create agent: \(error)")
                events.append(.error(error.localizedDescription))
            }
        }
    }
    
    /// Create agent with Component Model ABI
    private func createAgentInternal(config: AgentConfig) async throws -> Int32 {
        guard let instance = instance,
              let memory = instance.exports[memory: "memory"] else {
            throw NativeAgentError.notLoaded
        }
        
        // Get cabi_realloc for memory allocation
        guard let reallocFn = instance.exports[function: "cabi_realloc"] else {
            throw NativeAgentError.exportNotFound("cabi_realloc")
        }
        
        // Component Model ABI: create(config: agent-config) -> result<agent-handle, string>
        // agent-config is a record with:
        //   provider: string, model: string, api-key: string, base-url: option<string>,
        //   preamble: option<string>, preamble-override: option<string>,
        //   mcp-servers: option<list<mcp-server-config>>, max-turns: option<u32>
        
        // Serialize config to WASM memory using Component Model ABI
        let configPtr = try allocateAgentConfig(config: config, memory: memory, realloc: reallocFn)
        
        // Call create export
        guard let createFn = instance.exports[function: "create"] else {
            throw NativeAgentError.exportNotFound("create")
        }
        
        // Component Model: create takes a pointer to the config struct, returns result pointer
        // The core WASM function returns a single i32 that points to the result in memory
        let results = try createFn([.i32(UInt32(configPtr))])
        
        guard let resultPtrVal = results.first, case let .i32(resultPtr) = resultPtrVal else {
            throw NativeAgentError.invalidResult
        }
        
        // Read result from memory: result<agent-handle, string>
        // Layout: tag (1 byte), alignment padding (3 bytes), payload (4+ bytes)
        // tag 0 = Ok(agent-handle: u32), tag 1 = Err(string: ptr, len)
        var tag: UInt8 = 0
        var value: UInt32 = 0
        
        memory.withUnsafeMutableBufferPointer(offset: UInt(resultPtr), count: 8) { buffer in
            tag = buffer[0]
            // Value at offset 4 (aligned)
            value = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
        }
        
        // Call cabi_post_create to clean up the result
        if let postFn = instance.exports[function: "cabi_post_create"] {
            _ = try? postFn([.i32(resultPtr)])
        }
        
        if tag == 0 {
            // Ok - value is the agent handle
            Log.agent.info(" Agent created with handle: \(value)")
            return Int32(bitPattern: value)
        } else {
            // Err - value is a string pointer, read error message
            // For error, we need to read (ptr, len) from offset 4
            var errPtr: UInt32 = 0
            var errLen: UInt32 = 0
            memory.withUnsafeMutableBufferPointer(offset: UInt(resultPtr) + 4, count: 8) { buffer in
                errPtr = buffer.load(as: UInt32.self).littleEndian
                errLen = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
            }
            let errorMsg = readString(ptr: Int(errPtr), len: Int(errLen), memory: memory)
            throw NativeAgentError.createFailed(errorMsg)
        }
    }
    
    /// Send a message to the agent
    func send(_ message: String) {
        guard let handle = agentHandle, let instance = instance else {
            Log.agent.info(" No agent handle available")
            return
        }
        
        Task {
            do {
                try await sendInternal(handle: handle, message: message)
                // Start polling for events
                await pollEvents()
            } catch {
                Log.agent.info(" Send error: \(error)")
                await MainActor.run {
                    self.events.append(.error(error.localizedDescription))
                }
            }
        }
    }
    
    /// Send message with Component Model ABI
    private func sendInternal(handle: UInt32, message: String) async throws {
        guard let instance = instance,
              let memory = instance.exports[memory: "memory"],
              let reallocFn = instance.exports[function: "cabi_realloc"],
              let sendFn = instance.exports[function: "send"] else {
            throw NativeAgentError.notLoaded
        }
        
        // Allocate and write message string
        let messagePtr = try allocateString(message, memory: memory, realloc: reallocFn)
        let messageLen = message.utf8.count
        
        // Component Model: send(handle: u32, message_ptr: i32, message_len: i32) -> result_ptr: i32
        let results = try sendFn([
            .i32(handle),
            .i32(UInt32(messagePtr)),
            .i32(UInt32(messageLen))
        ])
        
        guard let resultPtrVal = results.first, case let .i32(resultPtr) = resultPtrVal else {
            throw NativeAgentError.invalidResult
        }
        
        // Read result<_, string> from memory
        // Layout: tag (1 byte, padded to 4), then error string if any
        var tag: UInt8 = 0
        memory.withUnsafeMutableBufferPointer(offset: UInt(resultPtr), count: 1) { buffer in
            tag = buffer[0]
        }
        
        // Call cabi_post_send to clean up
        if let postFn = instance.exports[function: "cabi_post_send"] {
            _ = try? postFn([.i32(resultPtr)])
        }
        
        if tag != 0 {
            // Error case - read error string
            var errPtr: UInt32 = 0
            var errLen: UInt32 = 0
            memory.withUnsafeMutableBufferPointer(offset: UInt(resultPtr) + 4, count: 8) { buffer in
                errPtr = buffer.load(as: UInt32.self).littleEndian
                errLen = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
            }
            let errorMsg = readString(ptr: Int(errPtr), len: Int(errLen), memory: memory)
            throw NativeAgentError.sendFailed(errorMsg)
        }
        
        Log.agent.info(" Message sent successfully")
    }
    
    /// Poll for events and update published state
    private func pollEvents() async {
        guard let instance = instance,
              let handle = agentHandle,
              let pollFn = instance.exports[function: "poll"],
              let memory = instance.exports[memory: "memory"] else {
            Log.agent.info(" pollEvents: missing instance, handle, or pollFn")
            return
        }
        
        Log.agent.info(" Starting poll loop for handle=\(handle)")
        
        // Polling loop
        while true {
            do {
                // Component Model: poll(handle: u32) -> result_ptr: i32
                // Returns pointer to option<agent-event>
                let results = try pollFn([.i32(handle)])
                
                guard let resultPtrVal = results.first, case let .i32(resultPtr) = resultPtrVal else {
                    Log.agent.info(" Poll returned no result")
                    break
                }
                
                // Read option<agent-event> from memory
                // Layout: tag (1 byte), padding, then payload if Some
                var optionTag: UInt8 = 0
                memory.withUnsafeMutableBufferPointer(offset: UInt(resultPtr), count: 1) { buffer in
                    optionTag = buffer[0]
                }
                
                // Call cabi_post_poll to clean up
                if let postFn = instance.exports[function: "cabi_post_poll"] {
                    _ = try? postFn([.i32(resultPtr)])
                }
                
                if optionTag == 0 {
                    // None - no event available, poll again after delay
                    try await Task.sleep(nanoseconds: 50_000_000) // 50ms
                    continue
                }
                
                Log.agent.info(" Poll got event, optionTag=\(optionTag)")
                
                // Some - parse the event from memory at offset 4 (after tag + padding)
                if let event = parseAgentEventFromMemory(ptr: Int(resultPtr) + 4, memory: memory) {
                    Log.agent.info(" Parsed event: \(String(describing: event))")
                    await MainActor.run {
                        self.events.append(event)
                        
                        // Update stream text for chunks
                        // Chunks contain cumulative text, so SET (not append)
                        // Only update if non-empty (empty chunks shouldn't clear the text)
                        if case .chunk(let text) = event, !text.isEmpty {
                            self.currentStreamText = text
                        }
                        // Don't clear on complete - let the text remain visible
                    }
                    
                    // Check for terminal events
                    if case .complete = event { break }
                    if case .error = event { break }
                    if case .ready = event {
                        // Ready event means agent is fully initialized
                        await MainActor.run {
                            self.isReady = true
                        }
                    }
                } else {
                    Log.agent.info(" Failed to parse event at ptr=\(resultPtr)")
                    // Couldn't parse event, wait and retry
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
            } catch {
                Log.agent.info(" Poll error: \(error)")
                break
            }
        }
        Log.agent.info(" Poll loop exited")
    }
    
    /// Clear conversation history
    func clearHistory() {
        events.removeAll()
        currentStreamText = ""
        
        guard let instance = instance,
              let handle = agentHandle,
              let clearFn = instance.exports[function: "clear-history"] else {
            return
        }
        
        do {
            _ = try clearFn([.i32(handle)])
        } catch {
            Log.agent.info(" Clear history error: \(error)")
        }
    }
    
    // MARK: - Component Model ABI Helpers
    
    /// Allocate memory using cabi_realloc
    private func allocateMemory(size: Int, align: Int, realloc: Function) throws -> Int {
        // cabi_realloc(old_ptr: i32, old_size: i32, align: i32, new_size: i32) -> i32
        let results = try realloc([
            .i32(0),           // old_ptr = null
            .i32(0),           // old_size = 0
            .i32(UInt32(align)),
            .i32(UInt32(size))
        ])
        
        guard let ptrResult = results.first, case let .i32(ptr) = ptrResult else {
            throw NativeAgentError.allocationFailed
        }
        
        return Int(ptr)
    }
    
    /// Allocate and write a string to WASM memory
    private func allocateString(_ string: String, memory: WasmKit.Memory, realloc: Function) throws -> Int {
        let bytes = Array(string.utf8)
        let ptr = try allocateMemory(size: bytes.count, align: 1, realloc: realloc)
        
        memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: bytes.count) { buffer in
            for (i, byte) in bytes.enumerated() {
                buffer[i] = byte
            }
        }
        
        return ptr
    }
    
    /// Allocate and serialize AgentConfig to WASM memory
    private func allocateAgentConfig(config: AgentConfig, memory: WasmKit.Memory, realloc: Function) throws -> Int {
        // Component Model record layout for agent-config:
        // Strings are (ptr, len) pairs
        // Options are (flag, value) pairs
        // Lists are (ptr, len) pairs
        
        // Allocate strings first
        let providerPtr = try allocateString(config.provider, memory: memory, realloc: realloc)
        let providerLen = config.provider.utf8.count
        
        let modelPtr = try allocateString(config.model, memory: memory, realloc: realloc)
        let modelLen = config.model.utf8.count
        
        let apiKeyPtr = try allocateString(config.apiKey, memory: memory, realloc: realloc)
        let apiKeyLen = config.apiKey.utf8.count
        
        // Optional base-url
        var baseUrlFlag: UInt32 = 0
        var baseUrlPtr: Int = 0
        var baseUrlLen: Int = 0
        if let baseUrl = config.baseUrl, !baseUrl.isEmpty {
            baseUrlFlag = 1
            baseUrlPtr = try allocateString(baseUrl, memory: memory, realloc: realloc)
            baseUrlLen = baseUrl.utf8.count
        }
        
        // Optional preamble
        var preambleFlag: UInt32 = 0
        var preamblePtr: Int = 0
        var preambleLen: Int = 0
        if let preamble = config.preamble, !preamble.isEmpty {
            preambleFlag = 1
            preamblePtr = try allocateString(preamble, memory: memory, realloc: realloc)
            preambleLen = preamble.utf8.count
        }
        
        // Optional preamble-override
        var preambleOverrideFlag: UInt32 = 0
        var preambleOverridePtr: Int = 0
        var preambleOverrideLen: Int = 0
        if let preambleOverride = config.preambleOverride, !preambleOverride.isEmpty {
            preambleOverrideFlag = 1
            preambleOverridePtr = try allocateString(preambleOverride, memory: memory, realloc: realloc)
            preambleOverrideLen = preambleOverride.utf8.count
        }
        
        // Optional mcp-servers
        var mcpServersFlag: UInt32 = 0
        var mcpServersPtr: Int = 0
        var mcpServersLen: Int = 0
        if let mcpServers = config.mcpServers, !mcpServers.isEmpty {
            mcpServersFlag = 1
            // Each mcp-server-config is (url_ptr, url_len, name_flag, name_ptr, name_len)
            let serverSize = 20 // 5 x i32
            mcpServersPtr = try allocateMemory(size: serverSize * mcpServers.count, align: 4, realloc: realloc)
            mcpServersLen = mcpServers.count
            
            for (i, server) in mcpServers.enumerated() {
                let urlPtr = try allocateString(server.url, memory: memory, realloc: realloc)
                let urlLen = server.url.utf8.count
                let nameFlag: UInt32 = server.name != nil ? 1 : 0
                let namePtr = server.name != nil ? try allocateString(server.name!, memory: memory, realloc: realloc) : 0
                let nameLen = server.name?.utf8.count ?? 0
                
                let offset = UInt(mcpServersPtr + i * serverSize)
                memory.withUnsafeMutableBufferPointer(offset: offset, count: serverSize) { buffer in
                    buffer.storeBytes(of: UInt32(urlPtr).littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(urlLen).littleEndian, toByteOffset: 4, as: UInt32.self)
                    buffer.storeBytes(of: nameFlag.littleEndian, toByteOffset: 8, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(namePtr).littleEndian, toByteOffset: 12, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(nameLen).littleEndian, toByteOffset: 16, as: UInt32.self)
                }
            }
        }
        
        // Optional max-turns
        let maxTurnsFlag: UInt32 = config.maxTurns != nil ? 1 : 0
        let maxTurnsValue: UInt32 = config.maxTurns ?? 25
        
        // Allocate the config struct
        // Layout: provider(ptr,len) + model(ptr,len) + api-key(ptr,len) +
        //         base-url(flag,ptr,len) + preamble(flag,ptr,len) + preamble-override(flag,ptr,len) +
        //         mcp-servers(flag,ptr,len) + max-turns(flag,value)
        // = 8 + 8 + 8 + 12 + 12 + 12 + 12 + 8 = 80 bytes
        let configSize = 80
        let configPtr = try allocateMemory(size: configSize, align: 4, realloc: realloc)
        
        memory.withUnsafeMutableBufferPointer(offset: UInt(configPtr), count: configSize) { buffer in
            var offset = 0
            
            // provider: string
            buffer.storeBytes(of: UInt32(providerPtr).littleEndian, toByteOffset: offset, as: UInt32.self)
            buffer.storeBytes(of: UInt32(providerLen).littleEndian, toByteOffset: offset + 4, as: UInt32.self)
            offset += 8
            
            // model: string
            buffer.storeBytes(of: UInt32(modelPtr).littleEndian, toByteOffset: offset, as: UInt32.self)
            buffer.storeBytes(of: UInt32(modelLen).littleEndian, toByteOffset: offset + 4, as: UInt32.self)
            offset += 8
            
            // api-key: string
            buffer.storeBytes(of: UInt32(apiKeyPtr).littleEndian, toByteOffset: offset, as: UInt32.self)
            buffer.storeBytes(of: UInt32(apiKeyLen).littleEndian, toByteOffset: offset + 4, as: UInt32.self)
            offset += 8
            
            // base-url: option<string>
            buffer.storeBytes(of: baseUrlFlag.littleEndian, toByteOffset: offset, as: UInt32.self)
            buffer.storeBytes(of: UInt32(baseUrlPtr).littleEndian, toByteOffset: offset + 4, as: UInt32.self)
            buffer.storeBytes(of: UInt32(baseUrlLen).littleEndian, toByteOffset: offset + 8, as: UInt32.self)
            offset += 12
            
            // preamble: option<string>
            buffer.storeBytes(of: preambleFlag.littleEndian, toByteOffset: offset, as: UInt32.self)
            buffer.storeBytes(of: UInt32(preamblePtr).littleEndian, toByteOffset: offset + 4, as: UInt32.self)
            buffer.storeBytes(of: UInt32(preambleLen).littleEndian, toByteOffset: offset + 8, as: UInt32.self)
            offset += 12
            
            // preamble-override: option<string>
            buffer.storeBytes(of: preambleOverrideFlag.littleEndian, toByteOffset: offset, as: UInt32.self)
            buffer.storeBytes(of: UInt32(preambleOverridePtr).littleEndian, toByteOffset: offset + 4, as: UInt32.self)
            buffer.storeBytes(of: UInt32(preambleOverrideLen).littleEndian, toByteOffset: offset + 8, as: UInt32.self)
            offset += 12
            
            // mcp-servers: option<list<mcp-server-config>>
            buffer.storeBytes(of: mcpServersFlag.littleEndian, toByteOffset: offset, as: UInt32.self)
            buffer.storeBytes(of: UInt32(mcpServersPtr).littleEndian, toByteOffset: offset + 4, as: UInt32.self)
            buffer.storeBytes(of: UInt32(mcpServersLen).littleEndian, toByteOffset: offset + 8, as: UInt32.self)
            offset += 12
            
            // max-turns: option<u32>
            buffer.storeBytes(of: maxTurnsFlag.littleEndian, toByteOffset: offset, as: UInt32.self)
            buffer.storeBytes(of: maxTurnsValue.littleEndian, toByteOffset: offset + 4, as: UInt32.self)
        }
        
        return configPtr
    }
    
    /// Read a string from WASM memory given a (ptr, len) result
    private func readStringFromResult(ptr: Int, memory: WasmKit.Memory) -> String {
        // For error results, ptr points to (string_ptr, string_len)
        var stringPtr: UInt32 = 0
        var stringLen: UInt32 = 0
        
        memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: 8) { buffer in
            stringPtr = buffer.load(fromByteOffset: 0, as: UInt32.self).littleEndian
            stringLen = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
        }
        
        var bytes = [UInt8](repeating: 0, count: Int(stringLen))
        memory.withUnsafeMutableBufferPointer(offset: UInt(stringPtr), count: Int(stringLen)) { buffer in
            for i in 0..<Int(stringLen) {
                bytes[i] = buffer[i]
            }
        }
        
        return String(bytes: bytes, encoding: .utf8) ?? ""
    }
    
    /// Parse an agent-event variant from WASM result
    private func parseAgentEvent(data: UInt32, memory: WasmKit.Memory) -> AgentEvent? {
        // agent-event is a variant with multiple cases
        // The data is a pointer to the variant representation
        // Format: tag (u8 or u32 depending on number of variants), followed by payload
        
        // Since we have 12 variants, tag is likely u8 but padded to 4 bytes
        var tag: UInt8 = 0
        memory.withUnsafeMutableBufferPointer(offset: UInt(data), count: 1) { buffer in
            tag = buffer[0]
        }
        
        switch tag {
        case 0: // stream-start
            return .streamStart
            
        case 1: // stream-chunk(string)
            // Read string at offset + 4
            var strPtr: UInt32 = 0
            var strLen: UInt32 = 0
            memory.withUnsafeMutableBufferPointer(offset: UInt(data) + 4, count: 8) { buffer in
                strPtr = buffer.load(as: UInt32.self).littleEndian
                strLen = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
            }
            let text = readString(ptr: Int(strPtr), len: Int(strLen), memory: memory)
            return .chunk(text)
            
        case 2: // stream-complete(string)
            var strPtr: UInt32 = 0
            var strLen: UInt32 = 0
            memory.withUnsafeMutableBufferPointer(offset: UInt(data) + 4, count: 8) { buffer in
                strPtr = buffer.load(as: UInt32.self).littleEndian
                strLen = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
            }
            let text = readString(ptr: Int(strPtr), len: Int(strLen), memory: memory)
            return .complete(text)
            
        case 3: // stream-error(string)
            var strPtr: UInt32 = 0
            var strLen: UInt32 = 0
            memory.withUnsafeMutableBufferPointer(offset: UInt(data) + 4, count: 8) { buffer in
                strPtr = buffer.load(as: UInt32.self).littleEndian
                strLen = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
            }
            let text = readString(ptr: Int(strPtr), len: Int(strLen), memory: memory)
            return .error(text)
            
        case 4: // tool-call(string)
            var strPtr: UInt32 = 0
            var strLen: UInt32 = 0
            memory.withUnsafeMutableBufferPointer(offset: UInt(data) + 4, count: 8) { buffer in
                strPtr = buffer.load(as: UInt32.self).littleEndian
                strLen = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
            }
            let name = readString(ptr: Int(strPtr), len: Int(strLen), memory: memory)
            return .toolCall(name)
            
        case 5: // tool-result(tool-result-data)
            // tool-result-data: { name: string, output: string, is-error: bool }
            var namePtr: UInt32 = 0, nameLen: UInt32 = 0
            var outputPtr: UInt32 = 0, outputLen: UInt32 = 0
            var isError: UInt8 = 0
            
            memory.withUnsafeMutableBufferPointer(offset: UInt(data) + 4, count: 20) { buffer in
                namePtr = buffer.load(as: UInt32.self).littleEndian
                nameLen = buffer.load(fromByteOffset: 4, as: UInt32.self).littleEndian
                outputPtr = buffer.load(fromByteOffset: 8, as: UInt32.self).littleEndian
                outputLen = buffer.load(fromByteOffset: 12, as: UInt32.self).littleEndian
                isError = buffer.load(fromByteOffset: 16, as: UInt8.self)
            }
            
            let name = readString(ptr: Int(namePtr), len: Int(nameLen), memory: memory)
            let output = readString(ptr: Int(outputPtr), len: Int(outputLen), memory: memory)
            return .toolResult(name: name, output: output, isError: isError != 0)
            
        case 11: // ready
            return .ready
            
        default:
            Log.agent.info(" Unknown event tag: \(tag)")
            return nil
        }
    }
    
    /// Parse an agent-event variant from a memory pointer (alias for parseAgentEvent)
    private func parseAgentEventFromMemory(ptr: Int, memory: WasmKit.Memory) -> AgentEvent? {
        return parseAgentEvent(data: UInt32(ptr), memory: memory)
    }
    
    /// Read a string from memory given ptr and len
    private func readString(ptr: Int, len: Int, memory: WasmKit.Memory) -> String {
        guard len > 0 else { return "" }
        
        var bytes = [UInt8](repeating: 0, count: len)
        memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: len) { buffer in
            for i in 0..<len {
                bytes[i] = buffer[i]
            }
        }
        return String(bytes: bytes, encoding: .utf8) ?? ""
    }
    
    // MARK: - WASI Import Registration
    
    /// Helper to define an import using the generated WASISignatures
    private func defineImport(
        _ imports: inout Imports,
        module: String,
        name: String,
        signature: WASISignatures.Signature,
        handler: @escaping (Caller, [WasmKit.Value]) -> [WasmKit.Value]
    ) {
        guard let store = store else { return }
        imports.define(module: module, name: name,
            Function(store: store, parameters: signature.parameters, results: signature.results, body: handler)
        )
    }
    
    private func registerWasiImports(_ imports: inout Imports) {
        guard let store = store else { return }
        
        // wasi_snapshot_preview1 (WASI Preview 1 compatibility layer)
        imports.define(module: "wasi_snapshot_preview1", name: "environ_get",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { _, _ in
                // Return success with no environment variables
                return [.i32(0)]
            }
        )
        
        imports.define(module: "wasi_snapshot_preview1", name: "environ_sizes_get",
            Function(store: store, parameters: [.i32, .i32], results: [.i32]) { caller, args in
                // Write 0 for environ_count and environ_buf_size
                if let memory = caller.instance?.exports[memory: "memory"] {
                    let countOffset = UInt(args[0].i32)
                    let sizeOffset = UInt(args[1].i32)
                    memory.withUnsafeMutableBufferPointer(offset: countOffset, count: 4) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                    }
                    memory.withUnsafeMutableBufferPointer(offset: sizeOffset, count: 4) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                    }
                }
                return [.i32(0)]
            }
        )
        
        imports.define(module: "wasi_snapshot_preview1", name: "proc_exit",
            Function(store: store, parameters: [.i32], results: []) { _, args in
                Log.agent.info(" proc_exit called with code: \(args[0].i32)")
                return []
            }
        )
    }
    
    private func registerHttpImports(_ imports: inout Imports) {
        guard let store = store else { return }
        
        // wasi:http/outgoing-handler@0.2.9 - handle
        // This is the main entry point for making HTTP requests
        // Parameters: request_handle: i32, options_has: i32, options_val: i32, ret_ptr: i32
        imports.define(module: "wasi:http/outgoing-handler@0.2.9", name: "handle",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let requestHandle = Int32(bitPattern: args[0].i32)
                // args[1] = option discriminant (0=None, 1=Some)
                // args[2] = option value (if discriminant is 1)
                let retPtr = UInt(args[3].i32)  // Return pointer is 4th argument
                
                Log.agent.info(" HTTP handle called - request:\(requestHandle), retPtr:\(retPtr)")
                
                // Get the request object
                guard let request: HTTPOutgoingRequest = self.resources.get(requestHandle) else {
                    Log.agent.info(" HTTP handle error: request not found")
                    // Write error to memory
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 4) { buffer in
                            buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self) // Error tag
                        }
                    }
                    return []
                }
                
                // Build the URL
                let scheme = request.scheme
                let authority = request.authority
                let path = request.path
                let url = "\(scheme)://\(authority)\(path)"
                
                Log.agent.info(" HTTP request: \(request.method) \(url)")
                
                // Get headers
                var headers: [(String, String)] = []
                if let fieldsHandle = self.resources.get(request.headersHandle) as HTTPFields? {
                    headers = fieldsHandle.entries
                }
                // Log headers with full length for x-api-key to debug truncation
                Log.agent.info(" HTTP headers (\(headers.count)):")
                for (name, value) in headers {
                    if name.lowercased().contains("api-key") {
                        Log.agent.debug("  \(name): length=\(value.count) chars")
                    } else {
                        Log.agent.debug("  \(name): \(value.prefix(80))")
                    }
                }
                
                // Get body data
                var bodyData: Data? = nil
                if let bodyHandle = request.outgoingBodyHandle,
                   let body: HTTPOutgoingBody = self.resources.get(bodyHandle) {
                    bodyData = body.getData()
                    if let data = bodyData {
                        Log.agent.info(" HTTP body (\(data.count) bytes): \(String(data: data.prefix(200), encoding: .utf8) ?? "binary")")
                    }
                }
                
                // Create FutureIncomingResponse and register it
                let future = FutureIncomingResponse()
                let futureHandle = self.resources.register(future)
                Log.agent.info(" HTTP registered futureHandle=\(futureHandle)")
                
                // Start async HTTP request
                self.httpManager.performRequest(
                    method: request.method,
                    url: url,
                    headers: headers,
                    body: bodyData,
                    future: future,
                    resources: self.resources
                )
                
                // Write success with future handle to memory
                // Layout: result<own<future-incoming-response>, error-code>
                // Rust bindings use 8-byte alignment (repr(align(8))) for return buffer
                // - discriminant: 1 byte at offset 0 (0 = Ok, 1 = Err)
                // - padding: 7 bytes (to align payload to 8)
                // - payload: 4 bytes at offset 8 (future handle or error code)
                if let memory = caller.instance?.exports[memory: "memory"] {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                        // Clear the buffer first
                        for i in 0..<16 {
                            buffer[i] = 0
                        }
                        // Write discriminant (1 byte): 0 = Ok
                        buffer[0] = 0
                        // Write future handle at offset 8 (after 1-byte discriminant + 7 bytes padding)
                        let handleBytes = withUnsafeBytes(of: UInt32(bitPattern: futureHandle).littleEndian) { Array($0) }
                        for (i, byte) in handleBytes.enumerated() {
                            buffer[8 + i] = byte
                        }
                    }
                    // Verify what we wrote
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                        Log.agent.info(" Memory bytes at \(retPtr): \(Array(buffer[0..<16]))")
                    }
                    Log.agent.info(" HTTP wrote futureHandle=\(futureHandle) to memory at offset \(retPtr)+8")
                }
                
                return []
            }
        )
        
        // wasi:http/types@0.2.9 - constructors
        imports.define(module: "wasi:http/types@0.2.9", name: "[constructor]fields",
            Function(store: store, parameters: [], results: [.i32]) { [weak self] _, _ in
                let handle = self?.resources.register(HTTPFields()) ?? 0
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        imports.define(module: "wasi:http/types@0.2.9", name: "[constructor]request-options",
            Function(store: store, parameters: [], results: [.i32]) { [weak self] _, _ in
                let handle = self?.resources.register(HTTPRequestOptions()) ?? 0
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        imports.define(module: "wasi:http/types@0.2.9", name: "[constructor]outgoing-request",
            Function(store: store, parameters: [.i32], results: [.i32]) { [weak self] _, args in
                let handle = self?.resources.register(HTTPOutgoingRequest(headers: args[0].i32)) ?? 0
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // [method]fields.append - append header value (6 params, no results)
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]fields.append",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let fieldsHandle = Int32(bitPattern: args[0].i32)
                let namePtr = UInt(args[1].i32)
                let nameLen = Int(args[2].i32)
                let valuePtr = UInt(args[3].i32)
                let valueLen = Int(args[4].i32)
                let resultPtr = UInt(args[5].i32)
                
                guard let fields: HTTPFields = self.resources.get(fieldsHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    // Write error to result ptr
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 1) { buffer in
                            buffer[0] = 1 // Error tag
                        }
                    }
                    return []
                }
                
                // Read name string
                var nameBytes = [UInt8](repeating: 0, count: nameLen)
                memory.withUnsafeMutableBufferPointer(offset: namePtr, count: nameLen) { buffer in
                    for i in 0..<nameLen {
                        nameBytes[i] = buffer[i]
                    }
                }
                let name = String(bytes: nameBytes, encoding: .utf8) ?? ""
                
                // Read value string
                var valueBytes = [UInt8](repeating: 0, count: valueLen)
                memory.withUnsafeMutableBufferPointer(offset: valuePtr, count: valueLen) { buffer in
                    for i in 0..<valueLen {
                        valueBytes[i] = buffer[i]
                    }
                }
                let value = String(bytes: valueBytes, encoding: .utf8) ?? ""
                
                fields.entries.append((name, value))
                
                // Write success (tag 0) to result ptr
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 1) { buffer in
                    buffer[0] = 0 // Success tag
                }
                return []
            }
        )
        
        // [method]fields.entries - takes (self, result-ptr), writes list of (name, value) pairs to memory
        // Returns: list<tuple<string, string>>
        // Layout: list = (ptr, len) where ptr points to array of tuples
        // Each tuple = (name_ptr: u32, name_len: u32, value_ptr: u32, value_len: u32) = 16 bytes
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]fields.entries",
            Function(store: store, parameters: [.i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                let fieldsHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let fields: HTTPFields = self.resources.get(fieldsHandle),
                      let memory = caller.instance?.exports[memory: "memory"],
                      let realloc = caller.instance?.exports[function: "cabi_realloc"] else {
                    Log.wasiHttp.debug(" fields.entries: missing fields, memory, or realloc")
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                            buffer.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 4, as: UInt32.self)
                        }
                    }
                    return []
                }
                
                let entries = fields.entries
                Log.wasiHttp.debug(" fields.entries called, fieldsHandle=\(fieldsHandle), entries=\(entries.count) headers")
                
                if entries.isEmpty {
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                        buffer.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                    return []
                }
                
                // Calculate tuple array size: entries.count * 16 bytes (4 u32s per tuple)
                let tupleArraySize = entries.count * 16
                
                // Allocate tuple array
                var tupleArrayPtr: UInt32 = 0
                do {
                    let tupleArrayResult = try realloc([.i32(0), .i32(0), .i32(4), .i32(UInt32(tupleArraySize))])
                    if let ptrVal = tupleArrayResult.first, case let .i32(ptr) = ptrVal {
                        tupleArrayPtr = ptr
                    }
                } catch {
                    Log.wasiHttp.debug(" fields.entries: failed to allocate tuple array: \(error)")
                }
                
                guard tupleArrayPtr != 0 else {
                    Log.wasiHttp.debug(" fields.entries: tuple array allocation returned 0")
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self)
                        buffer.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                    return []
                }
                
                // Write tuples with individually allocated strings
                var tupleOffset = UInt(tupleArrayPtr)
                
                for (name, value) in entries {
                    let nameBytes = Array(name.utf8)
                    let valueBytes = Array(value.utf8)
                    
                    // Allocate name string individually
                    var namePtr: UInt32 = 0
                    if nameBytes.count > 0 {
                        do {
                            let nameResult = try realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(nameBytes.count))])
                            if let ptrVal = nameResult.first, case let .i32(ptr) = ptrVal {
                                namePtr = ptr
                            }
                        } catch {
                            Log.wasiHttp.debug(" fields.entries: failed to allocate name string")
                        }
                        
                        if namePtr != 0 {
                            memory.withUnsafeMutableBufferPointer(offset: UInt(namePtr), count: nameBytes.count) { buffer in
                                for (i, byte) in nameBytes.enumerated() {
                                    buffer[i] = byte
                                }
                            }
                        }
                    }
                    
                    // Allocate value string individually
                    var valuePtr: UInt32 = 0
                    if valueBytes.count > 0 {
                        do {
                            let valueResult = try realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(valueBytes.count))])
                            if let ptrVal = valueResult.first, case let .i32(ptr) = ptrVal {
                                valuePtr = ptr
                            }
                        } catch {
                            Log.wasiHttp.debug(" fields.entries: failed to allocate value string")
                        }
                        
                        if valuePtr != 0 {
                            memory.withUnsafeMutableBufferPointer(offset: UInt(valuePtr), count: valueBytes.count) { buffer in
                                for (i, byte) in valueBytes.enumerated() {
                                    buffer[i] = byte
                                }
                            }
                        }
                    }
                    
                    // Write tuple: (name_ptr, name_len, value_ptr, value_len)
                    memory.withUnsafeMutableBufferPointer(offset: tupleOffset, count: 16) { buffer in
                        buffer.storeBytes(of: namePtr.littleEndian, as: UInt32.self)
                        buffer.storeBytes(of: UInt32(nameBytes.count).littleEndian, toByteOffset: 4, as: UInt32.self)
                        buffer.storeBytes(of: valuePtr.littleEndian, toByteOffset: 8, as: UInt32.self)
                        buffer.storeBytes(of: UInt32(valueBytes.count).littleEndian, toByteOffset: 12, as: UInt32.self)
                    }
                    tupleOffset += 16
                }
                
                // Write result: (ptr to tuple array, count)
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                    buffer.storeBytes(of: tupleArrayPtr.littleEndian, as: UInt32.self)
                    buffer.storeBytes(of: UInt32(entries.count).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                
                Log.wasiHttp.debug(" fields.entries: wrote \(entries.count) entries at ptr=\(tupleArrayPtr)")
                return []
            }
        )
        
        // [method]outgoing-request.set-method
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]outgoing-request.set-method",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { [weak self] caller, args in
                guard let self = self else { return [.i32(1)] }
                
                let requestHandle = Int32(bitPattern: args[0].i32)
                let methodTag = args[1].i32
                let methodValPtr = UInt(args[2].i32)
                let methodValLen = Int(args[3].i32)
                
                guard let request: HTTPOutgoingRequest = self.resources.get(requestHandle) else {
                    return [.i32(1)]
                }
                
                // Decode method tag
                switch methodTag {
                case 0: request.method = "GET"
                case 1: request.method = "HEAD"
                case 2: request.method = "POST"
                case 3: request.method = "PUT"
                case 4: request.method = "DELETE"
                case 5: request.method = "CONNECT"
                case 6: request.method = "OPTIONS"
                case 7: request.method = "TRACE"
                case 8: request.method = "PATCH"
                case 9: // Other - read from memory
                    if let memory = caller.instance?.exports[memory: "memory"], methodValLen > 0 {
                        var methodBytes = [UInt8](repeating: 0, count: methodValLen)
                        memory.withUnsafeMutableBufferPointer(offset: methodValPtr, count: methodValLen) { buffer in
                            for i in 0..<methodValLen {
                                methodBytes[i] = buffer[i]
                            }
                        }
                        request.method = String(bytes: methodBytes, encoding: .utf8) ?? "GET"
                    }
                default: break
                }
                
                return [.i32(0)] // Success
            }
        )
        
        // [method]outgoing-request.set-scheme
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]outgoing-request.set-scheme",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32, .i32], results: [.i32]) { [weak self] caller, args in
                guard let self = self else { return [.i32(1)] }
                
                let requestHandle = Int32(bitPattern: args[0].i32)
                let hasScheme = args[1].i32
                let schemeTag = args[2].i32
                let schemeValPtr = UInt(args[3].i32)
                let schemeValLen = Int(args[4].i32)
                
                guard let request: HTTPOutgoingRequest = self.resources.get(requestHandle) else {
                    return [.i32(1)]
                }
                
                if hasScheme != 0 {
                    switch schemeTag {
                    case 0: request.scheme = "http"
                    case 1: request.scheme = "https"
                    case 2: // Other
                        if let memory = caller.instance?.exports[memory: "memory"], schemeValLen > 0 {
                            var schemeBytes = [UInt8](repeating: 0, count: schemeValLen)
                            memory.withUnsafeMutableBufferPointer(offset: schemeValPtr, count: schemeValLen) { buffer in
                                for i in 0..<schemeValLen {
                                    schemeBytes[i] = buffer[i]
                                }
                            }
                            request.scheme = String(bytes: schemeBytes, encoding: .utf8) ?? "https"
                        }
                    default: break
                    }
                }
                
                return [.i32(0)] // Success
            }
        )
        
        // [method]outgoing-request.set-authority (Type 14: 4 params for option<string>)
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]outgoing-request.set-authority",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { [weak self] caller, args in
                guard let self = self else { return [.i32(1)] }
                
                let requestHandle = Int32(bitPattern: args[0].i32)
                let hasAuthority = args[1].i32
                let authorityPtr = UInt(args[2].i32)
                let authorityLen = Int(args[3].i32)
                
                guard let request: HTTPOutgoingRequest = self.resources.get(requestHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(1)]
                }
                
                if hasAuthority != 0 {
                    var authorityBytes = [UInt8](repeating: 0, count: authorityLen)
                    memory.withUnsafeMutableBufferPointer(offset: authorityPtr, count: authorityLen) { buffer in
                        for i in 0..<authorityLen {
                            authorityBytes[i] = buffer[i]
                        }
                    }
                    request.authority = String(bytes: authorityBytes, encoding: .utf8) ?? ""
                } else {
                    request.authority = ""
                }
                
                return [.i32(0)] // Success
            }
        )
        
        // [method]outgoing-request.set-path-with-query (Type 14: 4 params for option<string>)
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]outgoing-request.set-path-with-query",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: [.i32]) { [weak self] caller, args in
                guard let self = self else { return [.i32(1)] }
                
                let requestHandle = Int32(bitPattern: args[0].i32)
                let hasPath = args[1].i32
                let pathPtr = UInt(args[2].i32)
                let pathLen = Int(args[3].i32)
                
                guard let request: HTTPOutgoingRequest = self.resources.get(requestHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    return [.i32(1)]
                }
                
                if hasPath != 0 {
                    var pathBytes = [UInt8](repeating: 0, count: pathLen)
                    memory.withUnsafeMutableBufferPointer(offset: pathPtr, count: pathLen) { buffer in
                        for i in 0..<pathLen {
                            pathBytes[i] = buffer[i]
                        }
                    }
                    request.path = String(bytes: pathBytes, encoding: .utf8) ?? "/"
                } else {
                    request.path = ""
                }
                
                return [.i32(0)] // Success
            }
        )
        
        // [method]outgoing-request.body - returns OutgoingBody handle (Type 1: 2 params, no results)
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]outgoing-request.body",
            Function(store: store, parameters: [.i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let requestHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let request: HTTPOutgoingRequest = self.resources.get(requestHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self) // error
                        }
                    }
                    return []
                }
                
                // Create or return existing body
                if request.outgoingBodyHandle == nil {
                    let body = HTTPOutgoingBody()
                    let bodyHandle = self.resources.register(body)
                    request.outgoingBodyHandle = bodyHandle
                }
                
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                    buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self) // ok
                    buffer.storeBytes(of: UInt32(bitPattern: request.outgoingBodyHandle!).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // [method]outgoing-body.write - returns OutputStream handle (Type 1: 2 params, no results)
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]outgoing-body.write",
            Function(store: store, parameters: [.i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let bodyHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                
                guard let body: HTTPOutgoingBody = self.resources.get(bodyHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self) // error
                        }
                    }
                    return []
                }
                
                // Create output stream for body
                if body.outputStreamHandle == nil {
                    let stream = WASIOutputStream(body: body)
                    let streamHandle = self.resources.register(stream)
                    body.outputStreamHandle = streamHandle
                }
                
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                    buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self) // ok
                    buffer.storeBytes(of: UInt32(bitPattern: body.outputStreamHandle!).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // [static]outgoing-body.finish - params: (body, has-trailers, trailers, result-ptr)
        imports.define(module: "wasi:http/types@0.2.9", name: "[static]outgoing-body.finish",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let bodyHandle = Int32(bitPattern: args[0].i32)
                // args[1] = has-trailers (option discriminant)
                // args[2] = trailers handle (if has-trailers)
                let resultPtr = UInt(args[3].i32)
                
                if let body: HTTPOutgoingBody = self.resources.get(bodyHandle) {
                    body.finished = true
                }
                
                // Write success (tag 0) to result ptr
                if let memory = caller.instance?.exports[memory: "memory"] {
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 1) { buffer in
                        buffer[0] = 0 // Success tag
                    }
                }
                
                return []
            }
        )
        
        // [method]incoming-response.status
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]incoming-response.status",
            Function(store: store, parameters: [.i32], results: [.i32]) { [weak self] _, args in
                guard let self = self else { return [.i32(500)] }
                
                let responseHandle = Int32(bitPattern: args[0].i32)
                guard let response: HTTPIncomingResponse = self.resources.get(responseHandle) else {
                    return [.i32(500)]
                }
                
                return [.i32(UInt32(response.status))]
            }
        )
        
        // [method]incoming-response.headers
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]incoming-response.headers",
            Function(store: store, parameters: [.i32], results: [.i32]) { [weak self] _, args in
                guard let self = self else { return [.i32(0)] }
                
                let responseHandle = Int32(bitPattern: args[0].i32)
                guard let response: HTTPIncomingResponse = self.resources.get(responseHandle) else {
                    return [.i32(0)]
                }
                
                // Create new Fields from response headers
                let fields = HTTPFields()
                fields.entries = response.headers
                let fieldsHandle = self.resources.register(fields)
                
                return [.i32(UInt32(bitPattern: fieldsHandle))]
            }
        )
        
        // [method]incoming-response.consume - returns IncomingBody (Type 1: 2 params, no results)
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]incoming-response.consume",
            Function(store: store, parameters: [.i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let responseHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                Log.wasiHttp.debug(" incoming-response.consume called, responseHandle=\(responseHandle)")
                
                guard let response: HTTPIncomingResponse = self.resources.get(responseHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self) // error
                        }
                    }
                    return []
                }
                
                if response.bodyConsumed {
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self) // error - already consumed
                    }
                    return []
                }
                response.bodyConsumed = true
                
                // Create IncomingBody
                let body = HTTPIncomingBody(response: response)
                let bodyHandle = self.resources.register(body)
                Log.wasiHttp.debug(" consume: created bodyHandle=\(bodyHandle)")
                
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                    buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self) // ok
                    buffer.storeBytes(of: UInt32(bitPattern: bodyHandle).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
        
        // [method]incoming-body.stream - returns InputStream (Type 1: 2 params, no results)
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]incoming-body.stream",
            Function(store: store, parameters: [.i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let bodyHandle = Int32(bitPattern: args[0].i32)
                let resultPtr = UInt(args[1].i32)
                Log.wasiHttp.debug(" incoming-body.stream called, bodyHandle=\(bodyHandle)")
                
                guard let body: HTTPIncomingBody = self.resources.get(bodyHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    Log.wasiHttp.debug(" stream: ERROR - body lookup failed for handle=\(bodyHandle)")
                    // Write error result
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            buffer.storeBytes(of: UInt32(1).littleEndian, as: UInt32.self) // error tag
                        }
                    }
                    return []
                }
                
                // Create input stream if needed
                if body.inputStreamHandle == nil {
                    let stream = WASIInputStream(body: body)
                    let streamHandle = self.resources.register(stream)
                    body.inputStreamHandle = streamHandle
                    Log.wasiHttp.debug(" stream: created new streamHandle=\(streamHandle), response has \(body.response?.body.count ?? 0) bytes")
                } else {
                    Log.wasiHttp.debug(" stream: reusing streamHandle=\(body.inputStreamHandle!)")
                }
                
                // Write success result: (tag=0, handle)
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                    buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self) // ok tag
                    buffer.storeBytes(of: UInt32(bitPattern: body.inputStreamHandle!).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                
                return []
            }
        )
        
        // [method]future-incoming-response.get - poll for response (Type 1: 2 params, no results)
        // Returns: option<result<result<incoming-response, error-code>, ()>>
        // Layout (8-byte aligned, from Rust bindings):
        // - Offset 0: option discriminant (0=None, 1=Some)
        // - Offset 8: outer result discriminant (0=Ok, 1=Err)
        // - Offset 16: inner result discriminant (0=Ok, 1=Err)
        // - Offset 24: payload (response handle or error code)
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]future-incoming-response.get",
            Function(store: store, parameters: [.i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let futureHandle = Int32(bitPattern: args[0].i32)
                Log.wasiHttp.debug(" future-incoming-response.get called, handle=\(futureHandle)")
                let resultPtr = UInt(args[1].i32)
                
                guard let future: FutureIncomingResponse = self.resources.get(futureHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        // Return None
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 32) { buffer in
                            for i in 0..<32 { buffer[i] = 0 }
                            buffer[0] = 0  // None
                        }
                    }
                    return []
                }
                
                if let response = future.response {
                    Log.wasiHttp.debug(" future.get: response ready, status=\(response.status)")
                    // Return Some(Ok(Ok(response_handle)))
                    let responseHandle = self.resources.register(response)
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 32) { buffer in
                        for i in 0..<32 { buffer[i] = 0 }  // Clear
                        buffer[0] = 1  // Some
                        buffer[8] = 0  // Outer Result: Ok
                        buffer[16] = 0 // Inner Result: Ok
                        // Write response handle at offset 24
                        let handleBytes = withUnsafeBytes(of: UInt32(bitPattern: responseHandle).littleEndian) { Array($0) }
                        for (i, byte) in handleBytes.enumerated() {
                            buffer[24 + i] = byte
                        }
                    }
                    Log.wasiHttp.debug(" future.get: wrote responseHandle=\(responseHandle) at offset 24")
                } else if let error = future.error {
                    // Return Some(Ok(Err(error)))
                    Log.wasiHttp.debug(" future.get: error: \(error)")
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 32) { buffer in
                        for i in 0..<32 { buffer[i] = 0 }  // Clear
                        buffer[0] = 1  // Some
                        buffer[8] = 0  // Outer Result: Ok
                        buffer[16] = 1 // Inner Result: Err (error-code)
                        buffer[24] = 38 // InternalError variant (last one in error-code enum)
                    }
                } else {
                    // Response not ready - wait briefly for it
                    Log.wasiHttp.debug(" future.get: pending, waiting for response...")
                    let ready = future.waitForReady(timeout: 30)
                    
                    if ready, let response = future.response {
                        Log.wasiHttp.debug(" future.get: response arrived, status=\(response.status)")
                        let responseHandle = self.resources.register(response)
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 32) { buffer in
                            for i in 0..<32 { buffer[i] = 0 }
                            buffer[0] = 1  // Some
                            buffer[8] = 0  // Outer Result: Ok
                            buffer[16] = 0 // Inner Result: Ok
                            let handleBytes = withUnsafeBytes(of: UInt32(bitPattern: responseHandle).littleEndian) { Array($0) }
                            for (i, byte) in handleBytes.enumerated() {
                                buffer[24 + i] = byte
                            }
                        }
                        Log.wasiHttp.debug(" future.get: wrote responseHandle=\(responseHandle) at offset 24")
                    } else if let error = future.error {
                        Log.wasiHttp.debug(" future.get: error after wait: \(error)")
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 32) { buffer in
                            for i in 0..<32 { buffer[i] = 0 }
                            buffer[0] = 1  // Some
                            buffer[8] = 0  // Outer Result: Ok
                            buffer[16] = 1 // Inner Result: Err
                            buffer[24] = 38 // InternalError
                        }
                    } else {
                        Log.wasiHttp.debug(" future.get: timeout waiting for response")
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                            for i in 0..<8 { buffer[i] = 0 }
                            buffer[0] = 0  // None
                        }
                    }
                }
                return []
            }
        )
        
        // [method]future-incoming-response.subscribe - returns Pollable
        imports.define(module: "wasi:http/types@0.2.9", name: "[method]future-incoming-response.subscribe",
            Function(store: store, parameters: [.i32], results: [.i32]) { [weak self] _, args in
                guard let self = self else { return [.i32(0)] }
                
                let futureHandle = Int32(bitPattern: args[0].i32)
                guard let future: FutureIncomingResponse = self.resources.get(futureHandle) else {
                    Log.wasiHttp.debug(" subscribe: future not found!")
                    return [.i32(0)]
                }
                
                // Cache the pollable - return same handle on repeated calls
                if let cachedPollableHandle = future.cachedPollableHandle {
                    return [.i32(UInt32(bitPattern: cachedPollableHandle))]
                }
                
                Log.wasiHttp.debug(" future-incoming-response.subscribe called, futureHandle=\(futureHandle)")
                
                // Create a pollable for the future and cache it
                let pollable = HTTPPollable(future: future)
                let pollableHandle = self.resources.register(pollable)
                future.cachedPollableHandle = pollableHandle
                Log.wasiHttp.debug(" subscribe: returning pollableHandle=\(pollableHandle)")
                
                return [.i32(UInt32(bitPattern: pollableHandle))]
            }
        )
        
        // Resource drops
        imports.define(module: "wasi:http/types@0.2.9", name: "[resource-drop]fields",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        imports.define(module: "wasi:http/types@0.2.9", name: "[resource-drop]request-options",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        imports.define(module: "wasi:http/types@0.2.9", name: "[resource-drop]outgoing-request",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        imports.define(module: "wasi:http/types@0.2.9", name: "[resource-drop]outgoing-body",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        imports.define(module: "wasi:http/types@0.2.9", name: "[resource-drop]incoming-response",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        imports.define(module: "wasi:http/types@0.2.9", name: "[resource-drop]incoming-body",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        imports.define(module: "wasi:http/types@0.2.9", name: "[resource-drop]future-incoming-response",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
    }
    
    private func registerIoImports(_ imports: inout Imports) {
        guard let store = store else { return }
        
        // wasi:io/poll@0.2.9
        imports.define(module: "wasi:io/poll@0.2.9", name: "[method]pollable.block",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                guard let self = self else { return [] }
                
                let pollableHandle = Int32(bitPattern: args[0].i32)
                Log.wasiHttp.debug(" pollable.block called, handle=\(pollableHandle)")
                
                // Check if it's an HTTP pollable (for initial response)
                if let httpPollable: HTTPPollable = self.resources.get(pollableHandle) {
                    Log.wasiHttp.debug(" pollable.block: waiting for HTTP response...")
                    httpPollable.block(timeout: 30)
                    Log.wasiHttp.debug(" pollable.block: finished waiting, ready=\(httpPollable.isReady)")
                }
                // Check if it's a Stream pollable (for streaming data)
                else if let streamPollable: StreamPollable = self.resources.get(pollableHandle) {
                    Log.wasiHttp.debug(" pollable.block: waiting for stream data...")
                    streamPollable.block(timeout: 30)
                    Log.wasiHttp.debug(" pollable.block: finished waiting for stream, ready=\(streamPollable.isReady)")
                    // Reset pollable for next wait cycle
                    streamPollable.resetForNextWait()
                } else {
                    Log.wasiHttp.debug(" pollable.block: NO pollable found for handle \(pollableHandle)! Returning immediately.")
                }
                
                return []
            }
        )
        
        imports.define(module: "wasi:io/poll@0.2.9", name: "[method]pollable.ready",
            Function(store: store, parameters: [.i32], results: [.i32]) { [weak self] _, args in
                guard let self = self else { return [.i32(1)] }
                
                let pollableHandle = Int32(bitPattern: args[0].i32)
                
                if let httpPollable: HTTPPollable = self.resources.get(pollableHandle) {
                    return [.i32(httpPollable.isReady ? 1 : 0)]
                }
                
                if let streamPollable: StreamPollable = self.resources.get(pollableHandle) {
                    return [.i32(streamPollable.isReady ? 1 : 0)]
                }
                
                return [.i32(1)] // Default to ready
            }
        )
        
        imports.define(module: "wasi:io/poll@0.2.9", name: "[resource-drop]pollable",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // wasi:io/poll@0.2.4 (compatibility)
        imports.define(module: "wasi:io/poll@0.2.4", name: "[method]pollable.block",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                guard let self = self else { return [] }
                
                let pollableHandle = Int32(bitPattern: args[0].i32)
                
                // Check all pollable types
                if let httpPollable: HTTPPollable = self.resources.get(pollableHandle) {
                    httpPollable.block(timeout: 30)
                } else if let streamPollable: StreamPollable = self.resources.get(pollableHandle) {
                    streamPollable.block(timeout: 30)
                    streamPollable.resetForNextWait()
                } else if let durationPollable: DurationPollable = self.resources.get(pollableHandle) {
                    // For duration pollables, just sleep
                    let remaining = TimeInterval(durationPollable.nanoseconds) / 1_000_000_000 - Date().timeIntervalSince(durationPollable.createdAt)
                    if remaining > 0 {
                        Thread.sleep(forTimeInterval: min(remaining, 30))
                    }
                }
                
                return []
            }
        )
        imports.define(module: "wasi:io/poll@0.2.4", name: "[resource-drop]pollable",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // wasi:io/streams@0.2.9 - input-stream.blocking-read
        // Returns: result<list<u8>, stream-error>
        // Layout: tag (1 byte) + padding + list ptr (4 bytes) + list len (4 bytes)
        // For 8-byte alignment: tag at 0, ptr at 4, len at 8
        imports.define(module: "wasi:io/streams@0.2.9", name: "[method]input-stream.blocking-read",
            Function(store: store, parameters: [.i32, .i64, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let streamHandle = Int32(bitPattern: args[0].i32)
                let maxLen = args[1].i64
                let retPtr = UInt(args[2].i32)
                
                guard let stream: WASIInputStream = self.resources.get(streamHandle),
                      let memory = caller.instance?.exports[memory: "memory"],
                      let realloc = caller.instance?.exports[function: "cabi_realloc"] else {
                    Log.wasi.debug(" blocking-read: stream or memory not found")
                    return []
                }
                
                // Read data from the stream
                let data = stream.blockingRead(maxBytes: Int(maxLen))
                Log.wasi.debug(" blocking-read: read \(data.count) bytes, isEOF=\(stream.isEOF)")
                
                if data.isEmpty && stream.isEOF {
                    // EOF - return Err(stream-error::closed)
                    // stream-error is: last-operation-failed(error) = 0, closed = 1
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                        for i in 0..<16 { buffer[i] = 0 }
                        buffer[0] = 1  // Err tag
                        buffer[4] = 1  // stream-error::closed variant (1, not 0!)
                    }
                    Log.wasi.debug(" blocking-read: returning EOF (stream-error::closed)")
                    return []
                }
                
                // Allocate memory for the data
                // cabi_realloc(old_ptr, old_size, align, new_size) -> ptr
                let allocResult: [Value]
                do {
                    allocResult = try realloc([
                        .i32(0),  // old_ptr = null
                        .i32(0),  // old_size = 0
                        .i32(1),  // alignment = 1
                        .i32(UInt32(data.count))
                    ])
                } catch {
                    Log.wasi.debug(" blocking-read: allocation failed: \(error)")
                    return []
                }
                
                guard let ptrVal = allocResult.first, case let .i32(dataPtr) = ptrVal else {
                    Log.wasi.debug(" blocking-read: allocation returned invalid result")
                    return []
                }
                
                // Copy data to allocated memory
                memory.withUnsafeMutableBufferPointer(offset: UInt(dataPtr), count: data.count) { buffer in
                    for (i, byte) in data.enumerated() {
                        buffer[i] = byte
                    }
                }
                
                // Write Ok(list<u8>) result
                // Layout for result<list<u8>, stream-error>:
                // - offset 0: tag (Ok=0)
                // - offset 4: list ptr (i32)
                // - offset 8: list len (i32)
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buffer in
                    buffer[0] = 0  // Ok tag
                    buffer[1] = 0
                    buffer[2] = 0
                    buffer[3] = 0
                    // Write data pointer at offset 4
                    let ptrBytes = withUnsafeBytes(of: UInt32(dataPtr).littleEndian) { Array($0) }
                    for (i, byte) in ptrBytes.enumerated() {
                        buffer[4 + i] = byte
                    }
                    // Write length at offset 8
                    let lenBytes = withUnsafeBytes(of: UInt32(data.count).littleEndian) { Array($0) }
                    for (i, byte) in lenBytes.enumerated() {
                        buffer[8 + i] = byte
                    }
                }
                
                Log.wasi.debug(" blocking-read: wrote \(data.count) bytes at ptr=\(dataPtr)")
                
                return []
            }
        )
        
        // wasi:io/streams@0.2.9 - input-stream.read (non-blocking)
        // Same as blocking-read but returns immediately with available data
        imports.define(module: "wasi:io/streams@0.2.9", name: "[method]input-stream.read",
            Function(store: store, parameters: [.i32, .i64, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let streamHandle = Int32(bitPattern: args[0].i32)
                let maxLen = args[1].i64
                let retPtr = UInt(args[2].i32)
                
                guard let stream: WASIInputStream = self.resources.get(streamHandle),
                      let memory = caller.instance?.exports[memory: "memory"],
                      let realloc = caller.instance?.exports[function: "cabi_realloc"] else {
                    Log.wasi.debug(" read: stream or memory not found, handle=\(streamHandle)")
                    return []
                }
                
                // Read available data from the stream (non-blocking)
                let data = stream.read(maxBytes: Int(maxLen))
                Log.wasi.debug(" read: read \(data.count) bytes from streamHandle=\(streamHandle), isEOF=\(stream.isEOF)")
                
                if data.isEmpty && stream.isEOF {
                    // EOF - return Err(stream-error::closed)
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buffer in
                        for i in 0..<16 { buffer[i] = 0 }
                        buffer[0] = 1  // Err tag
                        buffer[4] = 1  // stream-error::closed
                    }
                    Log.wasi.debug(" read: returning EOF (stream-error::closed)")
                    return []
                }
                
                // Allocate memory for the data
                let allocResult: [Value]
                do {
                    allocResult = try realloc([
                        .i32(0),
                        .i32(0),
                        .i32(1),
                        .i32(UInt32(data.count))
                    ])
                } catch {
                    Log.wasi.debug(" read: allocation failed: \(error)")
                    return []
                }
                
                guard let ptrVal = allocResult.first, case let .i32(dataPtr) = ptrVal else {
                    Log.wasi.debug(" read: allocation returned invalid result")
                    return []
                }
                
                // Copy data to allocated memory
                memory.withUnsafeMutableBufferPointer(offset: UInt(dataPtr), count: data.count) { buffer in
                    for (i, byte) in data.enumerated() {
                        buffer[i] = byte
                    }
                }
                
                // Write Ok(list<u8>) result
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 12) { buffer in
                    buffer[0] = 0  // Ok tag
                    buffer[1] = 0
                    buffer[2] = 0
                    buffer[3] = 0
                    let ptrBytes = withUnsafeBytes(of: UInt32(dataPtr).littleEndian) { Array($0) }
                    for (i, byte) in ptrBytes.enumerated() {
                        buffer[4 + i] = byte
                    }
                    let lenBytes = withUnsafeBytes(of: UInt32(data.count).littleEndian) { Array($0) }
                    for (i, byte) in lenBytes.enumerated() {
                        buffer[8 + i] = byte
                    }
                }
                
                Log.wasi.debug(" read: wrote \(data.count) bytes at ptr=\(dataPtr)")
                return []
            }
        )
        imports.define(module: "wasi:io/streams@0.2.9", name: "[method]input-stream.subscribe",
            Function(store: store, parameters: [.i32], results: [.i32]) { [weak self] _, args in
                guard let self = self else { return [.i32(1)] }
                
                let streamHandle = Int32(bitPattern: args[0].i32)
                
                // Look up the WASIInputStream
                guard let stream: WASIInputStream = self.resources.get(streamHandle),
                      let body = stream.body,
                      let response = body.response else {
                    Log.wasi.debug(" input-stream.subscribe: no stream/body found for handle=\(streamHandle), returning stub")
                    return [.i32(1)]
                }
                
                // Create a StreamPollable that will signal when data is available
                let pollable = StreamPollable(response: response, streamHandle: streamHandle)
                body.addPollable(pollable)
                let pollableHandle = self.resources.register(pollable)
                
                Log.wasi.debug(" input-stream.subscribe: created StreamPollable=\(pollableHandle) for stream=\(streamHandle)")
                return [.i32(UInt32(bitPattern: pollableHandle))]
            }
        )
        imports.define(module: "wasi:io/streams@0.2.9", name: "[method]output-stream.blocking-write-and-flush",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let streamHandle = Int32(bitPattern: args[0].i32)
                let dataPtr = UInt(args[1].i32)
                let dataLen = Int(args[2].i32)
                let resultPtr = UInt(args[3].i32)
                
                guard let stream: WASIOutputStream = self.resources.get(streamHandle),
                      let memory = caller.instance?.exports[memory: "memory"] else {
                    // Write error result (tag = 1)
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 1) { buffer in
                            buffer[0] = 1 // error
                        }
                    }
                    return []
                }
                
                // Read data from WASM memory
                var data = [UInt8](repeating: 0, count: dataLen)
                memory.withUnsafeMutableBufferPointer(offset: dataPtr, count: dataLen) { buffer in
                    for i in 0..<dataLen {
                        data[i] = buffer[i]
                    }
                }
                
                // Write to the stream
                stream.write(Data(data))
                
                // Write success result (tag = 0)
                memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 1) { buffer in
                    buffer[0] = 0 // success
                }
                
                return []
            }
        )
        imports.define(module: "wasi:io/streams@0.2.9", name: "[resource-drop]input-stream",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        imports.define(module: "wasi:io/streams@0.2.9", name: "[resource-drop]output-stream",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // wasi:io/streams@0.2.4 (compatibility - for stderr)
        imports.define(module: "wasi:io/streams@0.2.4", name: "[method]output-stream.blocking-write-and-flush",
            Function(store: store, parameters: [.i32, .i32, .i32, .i32], results: []) { [weak self] caller, args in
                guard let self = self else { return [] }
                
                let streamHandle = Int32(bitPattern: args[0].i32)
                let dataPtr = Int(args[1].i32)
                let dataLen = Int(args[2].i32)
                let resultPtr = UInt(args[3].i32)
                
                // Check if this is a stderr stream
                if let stream: StderrOutputStream = self.resources.get(streamHandle) {
                    if let memory = caller.instance?.exports[memory: "memory"] {
                        var bytes = [UInt8](repeating: 0, count: dataLen)
                        memory.withUnsafeMutableBufferPointer(offset: UInt(dataPtr), count: dataLen) { buffer in
                            for i in 0..<dataLen {
                                bytes[i] = buffer[i]
                            }
                        }
                        stream.write(Data(bytes))
                        
                        // Write success result
                        memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 1) { buffer in
                            buffer[0] = 0 // success
                        }
                    }
                }
                
                return []
            }
        )
        imports.define(module: "wasi:io/streams@0.2.4", name: "[resource-drop]output-stream",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // wasi:io/error@0.2.9
        imports.define(module: "wasi:io/error@0.2.9", name: "[resource-drop]error",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        imports.define(module: "wasi:io/error@0.2.4", name: "[method]error.to-debug-string",
            Function(store: store, parameters: [.i32, .i32], results: []) { caller, args in
                // Write empty string to result pointer: (ptr=0, len=0)
                let resultPtr = UInt(args[1].i32)
                if let memory = caller.instance?.exports[memory: "memory"] {
                    memory.withUnsafeMutableBufferPointer(offset: resultPtr, count: 8) { buffer in
                        buffer.storeBytes(of: UInt32(0).littleEndian, as: UInt32.self) // ptr
                        buffer.storeBytes(of: UInt32(0).littleEndian, toByteOffset: 4, as: UInt32.self) // len
                    }
                }
                return []
            }
        )
        imports.define(module: "wasi:io/error@0.2.4", name: "[resource-drop]error",
            Function(store: store, parameters: [.i32], results: []) { [weak self] _, args in
                self?.resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
    }
    
    private func registerClocksImports(_ imports: inout Imports) {
        guard let store = store else { return }
        
        // wasi:clocks/monotonic-clock@0.2.4 - now
        imports.define(module: "wasi:clocks/monotonic-clock@0.2.4", name: "now",
            Function(store: store, parameters: [], results: [.i64]) { _, _ in
                // Return nanoseconds since some arbitrary epoch
                let now = DispatchTime.now().uptimeNanoseconds
                return [.i64(now)]
            }
        )
        
        // wasi:clocks/monotonic-clock@0.2.4 - subscribe-duration
        imports.define(module: "wasi:clocks/monotonic-clock@0.2.4", name: "subscribe-duration",
            Function(store: store, parameters: [.i64], results: [.i32]) { [weak self] _, args in
                // Create a pollable that will be ready after duration nanoseconds
                let handle = self?.resources.register(DurationPollable(nanoseconds: args[0].i64)) ?? 0
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // wasi:cli/stderr@0.2.4 - get-stderr (used for debug output)
        imports.define(module: "wasi:cli/stderr@0.2.4", name: "get-stderr",
            Function(store: store, parameters: [], results: [.i32]) { [weak self] _, _ in
                // Create a stderr output stream
                let stream = StderrOutputStream()
                let handle = self?.resources.register(stream) ?? 0
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
    }
    
    private func registerRandomImports(_ imports: inout Imports) {
        guard let store = store else { return }
        
        // wasi:random/insecure-seed@0.2.4
        imports.define(module: "wasi:random/insecure-seed@0.2.4", name: "insecure-seed",
            Function(store: store, parameters: [.i32], results: []) { caller, args in
                // Write 16 bytes of random data to the pointer
                var randomBytes = [UInt8](repeating: 0, count: 16)
                _ = SecRandomCopyBytes(kSecRandomDefault, 16, &randomBytes)
                
                if let memory = caller.instance?.exports[memory: "memory"] {
                    let offset = UInt(args[0].i32)
                    memory.withUnsafeMutableBufferPointer(offset: offset, count: 16) { buffer in
                        for (i, byte) in randomBytes.enumerated() {
                            buffer[i] = byte
                        }
                    }
                }
                return []
            }
        )
    }
}

// MARK: - HTTP Request Manager

/// Manages async HTTP requests using URLSession
final class HTTPRequestManager: @unchecked Sendable {
    private let session: URLSession
    
    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 300
        self.session = URLSession(configuration: config)
    }
    
    /// Perform an HTTP request and update the future when complete
    func performRequest(
        method: String,
        url: String,
        headers: [(String, String)],
        body: Data?,
        future: FutureIncomingResponse,
        resources: ResourceRegistry
    ) {
        // Rewrite wasm:// URLs to localhost MCP server for native runtime
        var effectiveURL = url
        if url.hasPrefix("wasm://") {
            // Use 127.0.0.1 instead of localhost to avoid IPv6/IPv4 resolution ambiguity
            effectiveURL = "http://127.0.0.1:9292/"
            if let query = URL(string: url)?.query {
                effectiveURL += "?\(query)"
            }
            Log.http.info(" Routing wasm:// to MCP server (127.0.0.1:9292)")
        }
        
        guard let requestURL = URL(string: effectiveURL) else {
            future.error = "Invalid URL: \(url)"
            return
        }
        
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        
        for (name, value) in headers {
            request.addValue(value, forHTTPHeaderField: name)
        }
        
        if let body = body {
            request.httpBody = body
        }
        
        Log.http.debug("Starting request: \(method) \(effectiveURL)")
        
        // Check if this is an SSE streaming request (Accept: text/event-stream exactly)
        let isSSE = headers.contains { $0.0.lowercased() == "accept" && $0.1 == "text/event-stream" }
        
        if isSSE {
            // SSE requests use StreamingDelegate for proper streaming support
            Log.http.debug("Using streaming delegate for SSE request")
            let delegate = StreamingDelegate(future: future)
            let delegateSession = URLSession(configuration: session.configuration, delegate: delegate, delegateQueue: nil)
            delegate.session = delegateSession
            let task = delegateSession.dataTask(with: request)
            task.resume()
        } else {
            // Non-SSE requests (like MCP JSON-RPC) use ephemeral session with completion handler
            // This prevents connection reuse issues with the local server
            let ephemeralConfig = URLSessionConfiguration.ephemeral
            ephemeralConfig.timeoutIntervalForRequest = 60
            let ephemeralSession = URLSession(configuration: ephemeralConfig)
            
            var ephemeralRequest = request
            ephemeralRequest.addValue("close", forHTTPHeaderField: "Connection")
            
            let task = ephemeralSession.dataTask(with: ephemeralRequest) { data, response, error in
                defer {
                    ephemeralSession.finishTasksAndInvalidate()
                }
                
                if let error = error {
                    Log.http.error("Request failed: \(error.localizedDescription)")
                    future.error = error.localizedDescription
                    future.signalReady()
                    return
                }
                
                guard let httpResponse = response as? HTTPURLResponse else {
                    future.error = "Invalid response type"
                    future.signalReady()
                    return
                }
                
                Log.http.debug("Response received: status=\(httpResponse.statusCode), body=\(data?.count ?? 0) bytes")
                
                var headers: [(String, String)] = []
                for (key, value) in httpResponse.allHeaderFields {
                    if let keyStr = key as? String, let valueStr = value as? String {
                        headers.append((keyStr.lowercased(), valueStr))
                    }
                }
                
                let incomingResponse = HTTPIncomingResponse(
                    status: httpResponse.statusCode,
                    headers: headers,
                    body: data ?? Data()
                )
                // Mark complete since we have the full body
                incomingResponse.streamComplete = true
                
                future.response = incomingResponse
                future.signalReady()
            }
            task.resume()
        }
    }
}

/// Streaming delegate for chunked HTTP responses (SSE)
/// Signals ready as soon as headers arrive, then continues streaming body data
class StreamingDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    weak var future: FutureIncomingResponse?
    /// Strong reference to keep the response alive for streaming data
    /// This is set when headers arrive and persists even if future is dropped
    var incomingResponse: HTTPIncomingResponse?
    var session: URLSession?  // Set by caller for proper cleanup
    private var receivedData = Data()
    private var response: HTTPURLResponse?
    private var headersSignaled = false
    private let dataLock = NSLock()
    
    init(future: FutureIncomingResponse) {
        self.future = future
    }
    
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse
        
        // Signal ready immediately when headers arrive for streaming!
        if let httpResponse = response as? HTTPURLResponse {
            Log.http.debug(" Headers received, status=\(httpResponse.statusCode)")
            
            var headers: [(String, String)] = []
            for (key, value) in httpResponse.allHeaderFields {
                if let keyStr = key as? String, let valueStr = value as? String {
                    headers.append((keyStr.lowercased(), valueStr))
                }
            }
            
            // Create response with empty body initially - body will be streamed
            let httpIncomingResponse = HTTPIncomingResponse(
                status: httpResponse.statusCode,
                headers: headers,
                body: Data()  // Empty initially, will be streamed
            )
            
            // Store STRONG reference for streaming data - survives future being dropped
            self.incomingResponse = httpIncomingResponse
            future?.response = httpIncomingResponse
            
            headersSignaled = true
            future?.signalReady()  // Signal IMMEDIATELY when headers arrive!
        }
        
        completionHandler(.allow)
    }
    
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        dataLock.lock()
        receivedData.append(data)
        
        // Append to the response body using STRONG reference (survives future being dropped)
        incomingResponse?.appendBody(data)
        dataLock.unlock()
        
        // Log streaming progress periodically
        if receivedData.count % 1000 < data.count {
            let bytes = self.receivedData.count
            Log.http.debug("Streaming: \(bytes) bytes received")
        }
    }
    
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer {
            // Clean up the session immediately to prevent connection issues
            // Use invalidateAndCancel since we're done with this session
            self.session?.invalidateAndCancel()
            self.session = nil
        }
        
        if let error = error {
            Log.http.debug(" Stream error: \(error)")
            future?.error = error.localizedDescription
            if !headersSignaled {
                future?.signalReady()
            }
            return
        }
        
        let totalBytes = self.receivedData.count
        let bodyBytes = self.incomingResponse?.body.count ?? 0
        Log.http.debug("Stream completed, total: \(totalBytes) bytes, final body size: \(bodyBytes) bytes")
        
        // Log error response body for debugging
        if let httpResponse = response, httpResponse.statusCode >= 400 {
            let bodyStr = String(data: self.receivedData, encoding: .utf8) ?? "binary"
            Log.http.debug("Error response body: \(bodyStr)")
        }
        
        // Mark the response stream as complete so WASI knows EOF is truly reached
        self.incomingResponse?.markStreamComplete()
        
        // Body is already updated incrementally via appendBody(), no need to replace
        // Signal ready if we haven't yet (shouldn't happen for streaming)
        if !headersSignaled {
            future?.signalReady()
        }
    }
}

// MARK: - Supporting Types

enum NativeAgentError: Error, LocalizedError {
    case wasmNotFound
    case notLoaded
    case exportNotFound(String)
    case invalidResult
    case invalidString
    case allocationFailed
    case createFailed(String)
    case sendFailed(String)
    
    var errorDescription: String? {
        switch self {
        case .wasmNotFound: return "WASM module not found in bundle"
        case .notLoaded: return "WASM module not loaded"
        case .exportNotFound(let name): return "Export not found: \(name)"
        case .invalidResult: return "Invalid result from WASM function"
        case .invalidString: return "Invalid string encoding"
        case .allocationFailed: return "Memory allocation failed"
        case .createFailed(let msg): return "Agent creation failed: \(msg)"
        case .sendFailed(let msg): return "Send failed: \(msg)"
        }
    }
}

struct NativeHTTPResponse {
    let status: Int
    let headers: [(String, String)]
    let body: Data
}

/// Resource registry for WASI handles
final class ResourceRegistry: @unchecked Sendable {
    private var nextHandle: Int32 = 1
    private var resources: [Int32: AnyObject] = [:]
    private let lock = NSLock()
    
    func register(_ resource: AnyObject) -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        
        let handle = nextHandle
        nextHandle += 1
        resources[handle] = resource
        return handle
    }
    
    func get<T: AnyObject>(_ handle: Int32) -> T? {
        lock.lock()
        defer { lock.unlock() }
        return resources[handle] as? T
    }
    
    func drop(_ handle: Int32) {
        lock.lock()
        defer { lock.unlock() }
        resources.removeValue(forKey: handle)
    }
}

// MARK: - WASI HTTP Resource Classes

class HTTPFields: NSObject {
    var entries: [(String, String)] = []
}

class HTTPRequestOptions: NSObject {
    var connectTimeout: UInt64?
    var firstByteTimeout: UInt64?
    var betweenBytesTimeout: UInt64?
}

class HTTPOutgoingRequest: NSObject {
    var headersHandle: Int32
    var method: String = "GET"
    var scheme: String = "https"
    var authority: String = ""
    var path: String = "/"
    var outgoingBodyHandle: Int32?
    
    init(headers: UInt32) {
        self.headersHandle = Int32(bitPattern: headers)
        super.init()
    }
}

class HTTPOutgoingBody: NSObject {
    var data = Data()
    var outputStreamHandle: Int32?
    var finished = false
    
    func write(_ chunk: Data) {
        data.append(chunk)
    }
    
    func getData() -> Data {
        return data
    }
}

class HTTPIncomingResponse: NSObject {
    let status: Int
    let headers: [(String, String)]
    var body: Data  // var to allow streaming updates
    var bodyConsumed = false
    var bodyReadOffset = 0
    var streamComplete = false  // Set to true when HTTP stream finishes
    private let bodyLock = NSLock()
    
    /// Callback triggered when new data is available (for signaling stream pollables)
    var onDataAvailable: (() -> Void)?
    
    /// Weak reference to associated body for direct signaling (set when body is created)
    weak var associatedBody: HTTPIncomingBody?
    
    init(status: Int, headers: [(String, String)], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }
    
    /// Append streaming body data (thread-safe)
    func appendBody(_ data: Data) {
        bodyLock.lock()
        body.append(data)
        let callback = onDataAvailable
        let body = associatedBody
        bodyLock.unlock()
        
        // Signal via direct body reference (preferred) or callback
        if let body = body {
            body.signalDataAvailable()
        } else {
            callback?()
        }
    }
    
    /// Mark the stream as complete (called when HTTP request finishes)
    func markStreamComplete() {
        bodyLock.lock()
        streamComplete = true
        bodyLock.unlock()
        Log.http.debug("Stream marked complete, total body size: \(body.count) bytes")
        
        // Signal stream completion
        onDataAvailable?()
    }
    
    func readBody(maxBytes: Int) -> Data {
        bodyLock.lock()
        defer { bodyLock.unlock() }
        
        let remaining = body.count - bodyReadOffset
        let toRead = min(maxBytes, remaining)
        
        if toRead <= 0 {
            return Data()
        }
        
        let chunk = body[bodyReadOffset..<(bodyReadOffset + toRead)]
        bodyReadOffset += toRead
        return chunk
    }
    
    var isBodyEOF: Bool {
        bodyLock.lock()
        defer { bodyLock.unlock() }
        // Only EOF if we've read all data AND the stream has completed
        return bodyReadOffset >= body.count && streamComplete
    }
    
    /// Check if there's unread data available
    var hasUnreadData: Bool {
        bodyLock.lock()
        defer { bodyLock.unlock() }
        return bodyReadOffset < body.count
    }
}

class HTTPIncomingBody: NSObject {
    // Strong reference to keep response alive during streaming
    var response: HTTPIncomingResponse?
    var inputStreamHandle: Int32?
    
    /// Pollables waiting for data on this stream
    var streamPollables: [StreamPollable] = []
    private let pollablesLock = NSLock()
    
    init(response: HTTPIncomingResponse) {
        self.response = response
        super.init()
        
        // Set direct body reference for signaling (works even before callback)
        response.associatedBody = self
        
        // Also connect response data callback as fallback
        response.onDataAvailable = { [weak self] in
            self?.signalDataAvailable()
        }
    }
    
    /// Add a pollable to be signaled when data arrives
    func addPollable(_ pollable: StreamPollable) {
        pollablesLock.lock()
        streamPollables.append(pollable)
        pollablesLock.unlock()
        
        // If data is already available, signal immediately
        if let response = response, (response.hasUnreadData || response.streamComplete) {
            pollable.signalDataAvailable()
        }
    }
    
    /// Signal all waiting pollables that data is available
    func signalDataAvailable() {
        pollablesLock.lock()
        let pollables = streamPollables
        pollablesLock.unlock()
        
        for pollable in pollables {
            pollable.signalDataAvailable()
        }
    }
}

class FutureIncomingResponse: NSObject {
    var response: HTTPIncomingResponse?
    var error: String?
    let semaphore = DispatchSemaphore(value: 0)
    
    /// Cached pollable handle to avoid creating new pollables on each subscribe call
    var cachedPollableHandle: Int32?
    
    var isReady: Bool {
        return response != nil || error != nil
    }
    
    /// Call this when response or error is set to wake up waiting threads
    func signalReady() {
        semaphore.signal()
    }
    
    /// Wait for response with timeout, returns true if ready
    func waitForReady(timeout: TimeInterval = 30) -> Bool {
        if isReady { return true }
        let result = semaphore.wait(timeout: .now() + timeout)
        return result == .success || isReady
    }
}

class HTTPPollable: NSObject {
    weak var future: FutureIncomingResponse?
    
    init(future: FutureIncomingResponse) {
        self.future = future
    }
    
    var isReady: Bool {
        return future?.isReady ?? true
    }
    
    /// Block until ready or timeout
    func block(timeout: TimeInterval = 30) {
        guard let future = future else { return }
        _ = future.waitForReady(timeout: timeout)
    }
}

// MARK: - WASI IO Streams

class WASIInputStream: NSObject {
    // Strong reference to keep body (and its response) alive during streaming
    var body: HTTPIncomingBody?
    
    init(body: HTTPIncomingBody) {
        self.body = body
    }
    
    func blockingRead(maxBytes: Int) -> Data {
        return body?.response?.readBody(maxBytes: maxBytes) ?? Data()
    }
    
    /// Non-blocking read - same as blockingRead since we preload data
    func read(maxBytes: Int) -> Data {
        return body?.response?.readBody(maxBytes: maxBytes) ?? Data()
    }
    
    var isEOF: Bool {
        return body?.response?.isBodyEOF ?? true
    }
}

class WASIOutputStream: NSObject {
    weak var body: HTTPOutgoingBody?
    
    init(body: HTTPOutgoingBody) {
        self.body = body
    }
    
    func write(_ data: Data) {
        body?.write(data)
    }
}

/// Pollable for duration-based timeouts
class DurationPollable: NSObject {
    let nanoseconds: UInt64
    let createdAt: Date
    
    init(nanoseconds: UInt64) {
        self.nanoseconds = nanoseconds
        self.createdAt = Date()
        super.init()
    }
    
    var isReady: Bool {
        let elapsed = Date().timeIntervalSince(createdAt) * 1_000_000_000
        return UInt64(elapsed) >= nanoseconds
    }
}

/// Pollable for streaming input - waits for more data to become available
class StreamPollable: NSObject {
    weak var response: HTTPIncomingResponse?
    let streamHandle: Int32
    let semaphore = DispatchSemaphore(value: 0)
    private var signaled = false
    private let lock = NSLock()
    
    init(response: HTTPIncomingResponse, streamHandle: Int32) {
        self.response = response
        self.streamHandle = streamHandle
        super.init()
    }
    
    var isReady: Bool {
        guard let response = response else { return true }
        // Ready if there's more data to read OR stream is complete
        return response.hasUnreadData || response.streamComplete
    }
    
    /// Signal that data is available (called when streaming data arrives)
    func signalDataAvailable() {
        lock.lock()
        if !signaled {
            signaled = true
            semaphore.signal()
        }
        lock.unlock()
    }
    
    /// Block until data is available or timeout
    func block(timeout: TimeInterval) {
        guard let response = response else { return }
        
        // Check if already ready
        if response.hasUnreadData || response.streamComplete {
            return
        }
        
        // Wait for signal with timeout
        _ = semaphore.wait(timeout: .now() + timeout)
    }
    
    /// Reset the semaphore for reuse after consuming data
    func resetForNextWait() {
        lock.lock()
        signaled = false
        lock.unlock()
    }
}

/// Stderr output stream for WASI debug output
class StderrOutputStream: NSObject {
    func write(_ data: Data) {
        if let str = String(data: data, encoding: .utf8) {
            // Use info level so WASM stderr is visible in Console.app
            Log.wasi.info("[stderr] \(str.trimmingCharacters(in: .newlines))")
        }
    }
}
