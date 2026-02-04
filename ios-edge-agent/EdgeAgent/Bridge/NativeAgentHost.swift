import Foundation
import WasmKit
import WasmParser
import Combine
import OSLog
import WASIP2Harness
import WASIShims

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
        
        // Create type-safe providers (including Preview1Provider for wasi_snapshot_preview1)
        let providers: [any WASIProvider] = [
            Preview1Provider(resources: resources),
            RandomProvider(),
            ClocksProvider(resources: resources),
            CliProvider(resources: resources),
            IoPollProvider(resources: resources),
            IoErrorProvider(resources: resources),
            IoStreamsProvider(resources: resources),
            SocketsProvider(resources: resources),
            HttpOutgoingHandlerProvider(resources: resources, httpManager: httpManager),
            HttpTypesProvider(resources: resources, httpManager: httpManager),
        ]
        
        // Validate providers against WASM module requirements
        let validationResult = WASIProviderValidator.validate(module: module, providers: providers)
        guard validationResult.isValid else {
            throw NativeAgentError.missingImports(validationResult.missingList)
        }
        
        // Register all providers
        for provider in providers {
            provider.register(into: &imports, store: store!)
        }
        
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
                
                if optionTag == 0 {
                    // None - no event available, clean up and poll again after delay
                    if let postFn = instance.exports[function: "cabi_post_poll"] {
                        _ = try? postFn([.i32(resultPtr)])
                    }
                    try await Task.sleep(nanoseconds: 50_000_000) // 50ms
                    continue
                }
                
                Log.agent.info(" Poll got event, optionTag=\(optionTag)")
                
                // Some - parse the event from memory at offset 4 (after tag + padding)
                // IMPORTANT: Parse BEFORE calling cabi_post_poll, as post_poll frees the memory
                if let event = parseAgentEventFromMemory(ptr: Int(resultPtr) + 4, memory: memory) {
                    Log.agent.info(" Parsed event: \(String(describing: event))")
                    
                    // NOW call cabi_post_poll to clean up after we've copied all data
                    if let postFn = instance.exports[function: "cabi_post_poll"] {
                        _ = try? postFn([.i32(resultPtr)])
                    }
                    
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
                    // Clean up even on parse failure
                    if let postFn = instance.exports[function: "cabi_post_poll"] {
                        _ = try? postFn([.i32(resultPtr)])
                    }
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
}

enum NativeAgentError: Error, LocalizedError {
    case wasmNotFound
    case notLoaded
    case exportNotFound(String)
    case invalidResult
    case invalidString
    case allocationFailed
    case createFailed(String)
    case sendFailed(String)
    case missingImports([String])
    
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
        case .missingImports(let missing): return "Missing WASI imports: \(missing.joined(separator: ", "))"
        }
    }
}
