/// ClocksProvider.swift
/// Type-safe WASI import provider for wasi:clocks interfaces
///
/// Uses MCPSignatures constants for ABI-correct function signatures.

import WasmKit
import WASIP2Harness
import OSLog

/// Provides type-safe WASI imports for clock interfaces.
public struct ClocksProvider: WASIProvider {
    public static var moduleName: String { "wasi:clocks" }
    
    /// All imports declared by this provider for compile-time validation
    public var declaredImports: [WASIImportDeclaration] {
        [
            WASIImportDeclaration(module: "wasi:clocks/monotonic-clock@0.2.4", name: "now", parameters: [], results: [.i64]),
            WASIImportDeclaration(module: "wasi:clocks/monotonic-clock@0.2.4", name: "subscribe-duration", parameters: [.i64], results: [.i32]),
            WASIImportDeclaration(module: "wasi:clocks/monotonic-clock@0.2.9", name: "subscribe-duration", parameters: [.i64], results: [.i32]),
            WASIImportDeclaration(module: "wasi:clocks/wall-clock@0.2.4", name: "now", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:clocks/wall-clock@0.2.9", name: "now", parameters: [.i32], results: []),
        ]
    }
    
    private let resources: ResourceRegistry
    
    private typealias MonoSig = MCPSignatures.clocks_monotonic_clock_0_2_4
    private typealias MonoSig_0_2_9 = MCPSignatures.clocks_monotonic_clock_0_2_9
    private typealias WallSig = MCPSignatures.clocks_wall_clock_0_2_9
    
    public init(resources: ResourceRegistry) {
        self.resources = resources
    }
    
    public func register(into imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // wasi:clocks/monotonic-clock@0.2.4
        let monoModule = "wasi:clocks/monotonic-clock@0.2.4"
        
        // now: () -> i64 (nanoseconds)
        imports.define(module: monoModule, name: "now",
            Function(store: store, parameters: MonoSig.now.parameters, results: MonoSig.now.results) { _, _ in
                let nanos = UInt64(DispatchTime.now().uptimeNanoseconds)
                return [.i64(nanos)]
            }
        )
        
        // subscribe-duration: (i64) -> i32 (also needed for 0.2.4)
        imports.define(module: monoModule, name: "subscribe-duration",
            Function(store: store, parameters: [.i64], results: [.i32]) { _, args in
                let nanoseconds = args[0].i64
                let pollable = TimePollable(nanoseconds: nanoseconds)
                let handle = resources.register(pollable)
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // wasi:clocks/monotonic-clock@0.2.9
        let monoModule_0_2_9 = "wasi:clocks/monotonic-clock@0.2.9"
        
        // subscribe-duration: (i64) -> i32
        imports.define(module: monoModule_0_2_9, name: "subscribe-duration",
            Function(store: store, parameters: MonoSig_0_2_9.subscribe_duration.parameters, results: MonoSig_0_2_9.subscribe_duration.results) { _, args in
                let nanoseconds = args[0].i64
                let pollable = TimePollable(nanoseconds: nanoseconds)
                let handle = resources.register(pollable)
                return [.i32(UInt32(bitPattern: handle))]
            }
        )
        
        // Helper closure for wall-clock now implementation (shared between versions)
        let wallClockNow: (Caller, [Value]) throws -> [Value] = { caller, args in
            guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
            
            let retPtr = UInt(args[0].i32)
            let now = Date()
            let seconds = UInt64(now.timeIntervalSince1970)
            let nanoseconds = UInt32((now.timeIntervalSince1970.truncatingRemainder(dividingBy: 1)) * 1_000_000_000)
            
            memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buf in
                buf.storeBytes(of: seconds.littleEndian, toByteOffset: 0, as: UInt64.self)
                buf.storeBytes(of: nanoseconds.littleEndian, toByteOffset: 8, as: UInt32.self)
            }
            return []
        }
        
        // wasi:clocks/wall-clock@0.2.4
        imports.define(module: "wasi:clocks/wall-clock@0.2.4", name: "now",
            Function(store: store, parameters: WallSig.now.parameters, results: WallSig.now.results, body: wallClockNow)
        )
        
        // wasi:clocks/wall-clock@0.2.9
        imports.define(module: "wasi:clocks/wall-clock@0.2.9", name: "now",
            Function(store: store, parameters: WallSig.now.parameters, results: WallSig.now.results, body: wallClockNow)
        )
    }
}
