import Foundation
import WasmKit
import WASIP2Harness
import WasmParser
import OSLog

/// Lightweight executor for direct TypeScript/JavaScript evaluation via WASM.
///
/// Unlike `WASMLazyProcess` (which manages full process lifecycle with streams),
/// `ScriptExecutor` calls the `shell:unix/eval@0.1.0#eval` export directly:
/// code string in → result string out. No stdin/stdout/stderr plumbing.
///
/// Thread-safe: all WASM state is created per-invocation (no shared mutable state).
public final class ScriptExecutor: @unchecked Sendable {
    
    public static let shared = ScriptExecutor()
    
    /// Optional callback for `ios:bridge/render@0.1.0#show`.
    /// Called when a script invokes `render.show(json)` — returns a view ID string.
    /// Set by `EdgeAgentSession` to forward render events to the UI layer.
    public var onRenderShow: ((String) -> String)?
    
    /// Optional callback for `ios:bridge/render@0.1.0#patch`.
    /// Called when a script invokes `render.patch(json)` — returns "ok" or error.
    /// Set by `EdgeAgentSession` to forward patch events to ComponentState.
    public var onRenderPatch: ((String) -> String)?
    
    private init() {}
    
    // MARK: - Public API
    
    /// Evaluate TypeScript/JavaScript code directly.
    /// Returns `(success: Bool, output: String?)` matching the `onShellEval` callback shape.
    public func eval(code: String, sourceName: String? = nil) async -> (Bool, String?) {
        return await Task.detached(priority: .userInitiated) {
            self.evalSync(code: code, sourceName: sourceName)
        }.value
    }
    
    /// Evaluate a TypeScript/JavaScript file by path.
    /// Returns `(success: Bool, output: String?)` matching the `onShellEval` callback shape.
    public func evalFile(path: String, args: [String] = [], appId: String = "global", scriptName: String = "global") async -> (Bool, String?) {
        return await Task.detached(priority: .userInitiated) {
            self.evalFileSync(path: path, args: args, appId: appId, scriptName: scriptName)
        }.value
    }
    
    // MARK: - Synchronous Implementation (runs on detached task)
    
    private func evalSync(code: String, sourceName: String?) -> (Bool, String?) {
        do {
            let (instance, store, memory, realloc) = try setupWASM()
            
            guard let evalFunc = instance.exports[function: "shell:unix/eval@0.1.0#eval"] else {
                throw WasmKitHostError.exportNotFound("shell:unix/eval@0.1.0#eval")
            }
            
            // Allocate code string
            let (codePtr, codeLen) = try allocString(code, memory: memory, realloc: realloc)
            
            // Allocate option<string> for source_name
            // Component Model option: discriminant (0=none, 1=some), then payload if some
            let optionFlag: UInt32
            let srcPtr: UInt32
            let srcLen: UInt32
            if let name = sourceName {
                optionFlag = 1
                let (p, l) = try allocString(name, memory: memory, realloc: realloc)
                srcPtr = p
                srcLen = l
            } else {
                optionFlag = 0
                srcPtr = 0
                srcLen = 0
            }
            
            // Allocate return area (12 bytes: discriminant i32 + ptr i32 + len i32)
            let retAreaSize: UInt32 = 12
            guard let retResult = try? realloc([.i32(0), .i32(0), .i32(4), .i32(retAreaSize)]),
                  let retVal = retResult.first, case let .i32(retPtr) = retVal else {
                throw WasmKitHostError.allocationFailed
            }
            
            // Call: eval(code_ptr, code_len, option_flag, src_ptr, src_len) -> i32
            let result = try evalFunc([
                .i32(codePtr),
                .i32(codeLen),
                .i32(optionFlag),
                .i32(srcPtr),
                .i32(srcLen),
            ])
            
            // The return value is a pointer to the result area
            let resultPtr: UInt32
            if let rv = result.first, case let .i32(v) = rv {
                resultPtr = v
            } else {
                resultPtr = retPtr
            }
            
            // Read result<string, string> from return area
            let (success, output) = try readResultString(at: resultPtr, memory: memory)
            
            // Call post-return cleanup
            if let postReturn = instance.exports[function: "cabi_post_shell:unix/eval@0.1.0#eval"] {
                _ = try? postReturn([.i32(resultPtr)])
            }
            
            Log.mcp.info("ScriptExecutor: eval completed, success=\(success), output=\(output?.prefix(100) ?? "nil")")
            return (success, output)
            
        } catch {
            Log.mcp.error("ScriptExecutor: eval failed: \(error)")
            return (false, "ScriptExecutor error: \(error.localizedDescription)")
        }
    }
    
    private func evalFileSync(path: String, args: [String], appId: String = "global", scriptName: String = "global") -> (Bool, String?) {
        do {
            let (instance, store, memory, realloc) = try setupWASM(appId: appId, scriptName: scriptName)
            
            guard let evalFileFunc = instance.exports[function: "shell:unix/eval@0.1.0#eval-file"] else {
                throw WasmKitHostError.exportNotFound("shell:unix/eval@0.1.0#eval-file")
            }
            
            // Allocate path string
            let (pathPtr, pathLen) = try allocString(path, memory: memory, realloc: realloc)
            
            // Allocate args list<string>
            var argEntries: [(ptr: UInt32, len: UInt32)] = []
            for arg in args {
                let entry = try allocString(arg, memory: memory, realloc: realloc)
                argEntries.append(entry)
            }
            
            let argsArraySize = UInt32(argEntries.count * 8)
            var argsPtr: UInt32 = 0
            if argsArraySize > 0 {
                if let result = try? realloc([.i32(0), .i32(0), .i32(4), .i32(argsArraySize)]),
                   let val = result.first, case let .i32(ptr) = val {
                    argsPtr = ptr
                }
                for (i, entry) in argEntries.enumerated() {
                    let offset = UInt(argsPtr) + UInt(i * 8)
                    memory.withUnsafeMutableBufferPointer(offset: offset, count: 8) { buffer in
                        buffer.storeBytes(of: entry.ptr.littleEndian, as: UInt32.self)
                        buffer.storeBytes(of: entry.len.littleEndian, toByteOffset: 4, as: UInt32.self)
                    }
                }
            }
            let argsLen = UInt32(argEntries.count)
            
            // Call: eval-file(path_ptr, path_len, args_ptr, args_len) -> i32
            let result = try evalFileFunc([
                .i32(pathPtr),
                .i32(pathLen),
                .i32(argsPtr),
                .i32(argsLen),
            ])
            
            let resultPtr: UInt32
            if let rv = result.first, case let .i32(v) = rv {
                resultPtr = v
            } else {
                throw WasmKitHostError.invalidResult
            }
            
            // Read result<string, string> from return area
            let (success, output) = try readResultString(at: resultPtr, memory: memory)
            
            // Post-return cleanup
            if let postReturn = instance.exports[function: "cabi_post_shell:unix/eval@0.1.0#eval-file"] {
                _ = try? postReturn([.i32(resultPtr)])
            }
            
            Log.mcp.info("ScriptExecutor: eval-file completed, success=\(success)")
            return (success, output)
            
        } catch {
            Log.mcp.error("ScriptExecutor: eval-file failed: \(error)")
            return (false, "ScriptExecutor error: \(error.localizedDescription)")
        }
    }
    
    // MARK: - WASM Setup
    
    /// Create a fresh WASM instance with all WASI providers registered.
    /// Each invocation gets its own Engine/Store/Instance — no shared mutable state.
    private func setupWASM(appId: String = "global", scriptName: String = "global") throws -> (Instance, Store, WasmKit.Memory, Function) {
        let module = try LazyModuleRegistry.shared.loadModule(named: "tsx-engine")
        
        let engine = Engine()
        let store = Store(engine: engine)
        
        var imports = Imports()
        let resources = ResourceRegistry()
        let httpManager = HTTPRequestManager()
        let filesystem = SandboxFilesystem.shared
        
        // Reset FD table to prevent leaks from previous WASM invocations
        filesystem.resetForNewInstance()
        
        let providers: [any WASIProvider] = [
            Preview1Provider(resources: resources, filesystem: filesystem),
            RandomProvider(),
            ClocksProvider(resources: resources),
            CliProvider(resources: resources),
            IoPollProvider(resources: resources),
            IoErrorProvider(resources: resources),
            IoStreamsProvider(resources: resources),
            SocketsProvider(resources: resources),
            HttpOutgoingHandlerProvider(resources: resources, httpManager: httpManager),
            HttpTypesProvider(resources: resources, httpManager: httpManager),
            {
                let provider = IosBridgeProvider(appId: appId, scriptName: scriptName)
                provider.onRenderShow = self.onRenderShow
                provider.onRenderPatch = self.onRenderPatch
                return provider
            }(),
        ]
        
        for provider in providers {
            provider.register(into: &imports, store: store)
        }
        
        let instance = try module.instantiate(store: store, imports: imports)
        
        guard let memory = instance.exports[memory: "memory"] else {
            throw WasmKitHostError.operationFailed("WASM module has no exported memory")
        }
        
        guard let realloc = instance.exports[function: "cabi_realloc"] else {
            throw WasmKitHostError.exportNotFound("cabi_realloc")
        }
        
        return (instance, store, memory, realloc)
    }
    
    // MARK: - Component Model ABI Helpers
    
    /// Allocate and write a string into WASM linear memory via cabi_realloc.
    private func allocString(_ str: String, memory: WasmKit.Memory, realloc: Function) throws -> (ptr: UInt32, len: UInt32) {
        let bytes = Array(str.utf8)
        let len = UInt32(bytes.count)
        if len == 0 {
            return (0, 0)
        }
        guard let result = try? realloc([.i32(0), .i32(0), .i32(1), .i32(len)]),
              let ptrVal = result.first, case let .i32(ptr) = ptrVal else {
            throw WasmKitHostError.allocationFailed
        }
        memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: bytes.count) { buffer in
            for (i, byte) in bytes.enumerated() {
                buffer[i] = byte
            }
        }
        return (ptr, len)
    }
    
    /// Read a `result<string, string>` from WASM memory at the given pointer.
    /// Layout: discriminant (i32, 0=ok 1=err) | payload_ptr (i32) | payload_len (i32)
    private func readResultString(at ptr: UInt32, memory: WasmKit.Memory) throws -> (success: Bool, output: String?) {
        var discriminant: UInt32 = 0
        var payloadPtr: UInt32 = 0
        var payloadLen: UInt32 = 0
        
        memory.withUnsafeMutableBufferPointer(offset: UInt(ptr), count: 12) { buffer in
            discriminant = buffer.loadUnaligned(as: UInt32.self)
            payloadPtr = buffer.loadUnaligned(fromByteOffset: 4, as: UInt32.self)
            payloadLen = buffer.loadUnaligned(fromByteOffset: 8, as: UInt32.self)
        }
        
        let isOk = discriminant == 0
        
        var outputString: String? = nil
        if payloadLen > 0 {
            memory.withUnsafeMutableBufferPointer(offset: UInt(payloadPtr), count: Int(payloadLen)) { buffer in
                outputString = String(bytes: buffer, encoding: .utf8)
            }
        }
        
        return (isOk, outputString)
    }
}
