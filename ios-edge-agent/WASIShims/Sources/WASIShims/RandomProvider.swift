/// RandomProvider.swift
/// Type-safe WASI import provider for wasi:random interfaces
///
/// Uses MCPSignatures constants for ABI-correct function signatures.

import WasmKit
import WASIP2Harness
import OSLog

/// Provides type-safe WASI imports for random interfaces.
public struct RandomProvider: WASIProvider {
    public static var moduleName: String { "wasi:random" }
    
    public init() {}
    
    /// All imports declared by this provider for compile-time validation
    public var declaredImports: [WASIImportDeclaration] {
        [
            WASIImportDeclaration(module: "wasi:random/insecure-seed@0.2.4", name: "insecure-seed", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:random/random@0.2.9", name: "get-random-u64", parameters: [], results: [.i64]),
            WASIImportDeclaration(module: "wasi:random/random@0.2.9", name: "get-random-bytes", parameters: [.i64, .i32], results: []),
        ]
    }
    
    private typealias InsecureSeedSig = MCPSignatures.random_insecure_seed_0_2_4
    private typealias RandomSig = MCPSignatures.random_random_0_2_9
    
    public func register(into imports: inout Imports, store: Store) {
        
        // wasi:random/insecure-seed@0.2.4
        let insecureModule = "wasi:random/insecure-seed@0.2.4"
        
        // insecure-seed: (ret_ptr) -> ()
        imports.define(module: insecureModule, name: "insecure-seed",
            Function(store: store, parameters: InsecureSeedSig.insecure_seed.parameters, results: InsecureSeedSig.insecure_seed.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let retPtr = UInt(args[0].i32)
                let seed1 = UInt64.random(in: UInt64.min...UInt64.max)
                let seed2 = UInt64.random(in: UInt64.min...UInt64.max)
                
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 16) { buf in
                    buf.storeBytes(of: seed1.littleEndian, toByteOffset: 0, as: UInt64.self)
                    buf.storeBytes(of: seed2.littleEndian, toByteOffset: 8, as: UInt64.self)
                }
                return []
            }
        )
        
        // wasi:random/random@0.2.9
        let randomModule = "wasi:random/random@0.2.9"
        
        // get-random-u64: () -> i64
        imports.define(module: randomModule, name: "get-random-u64",
            Function(store: store, parameters: RandomSig.get_random_u64.parameters, results: RandomSig.get_random_u64.results) { _, _ in
                let value = UInt64.random(in: UInt64.min...UInt64.max)
                return [.i64(value)]
            }
        )
        
        // get-random-bytes: (count, ret_ptr) -> ()
        imports.define(module: randomModule, name: "get-random-bytes",
            Function(store: store, parameters: RandomSig.get_random_bytes.parameters, results: RandomSig.get_random_bytes.results) { caller, args in
                guard let memory = caller.instance?.exports[memory: "memory"] else { return [] }
                
                let count = Int(args[0].i64)
                let retPtr = UInt(args[1].i32)
                
                // Allocate bytes in WASM memory
                guard let realloc = caller.instance?.exports[function: "cabi_realloc"],
                      let result = try? realloc([.i32(0), .i32(0), .i32(1), .i32(UInt32(count))]),
                      case let .i32(dataPtr) = result.first else {
                    memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                        for i in 0..<8 { buf[i] = 0 }
                    }
                    return []
                }
                
                // Generate random bytes
                memory.withUnsafeMutableBufferPointer(offset: UInt(dataPtr), count: count) { buf in
                    for i in 0..<count {
                        buf[i] = UInt8.random(in: 0...255)
                    }
                }
                
                // Write result (ptr, len)
                memory.withUnsafeMutableBufferPointer(offset: retPtr, count: 8) { buf in
                    buf.storeBytes(of: dataPtr.littleEndian, as: UInt32.self)
                    buf.storeBytes(of: UInt32(count).littleEndian, toByteOffset: 4, as: UInt32.self)
                }
                return []
            }
        )
    }
}
