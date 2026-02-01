/**
 * WASM Import Signature Generator using WasmKit
 * 
 * Parses a WASM module directly with WasmKit and generates Swift stub implementations
 * with the correct function signatures.
 * 
 * Usage: swift run generate-wasi-stubs <wasm-file> [--summary]
 */

import Foundation
import WasmKit
import SystemPackage

// MARK: - Main

@main
struct GenerateWASIStubs {
    static func main() throws {
        let args = CommandLine.arguments
        
        guard args.count >= 2 else {
            fputs("Usage: generate-wasi-stubs <wasm-file> [--summary]\n", stderr)
            exit(1)
        }
        
        let wasmPath = args[1]
        let showSummary = args.contains("--summary")
        let generateSwift = args.contains("--swift")
        
        // Parse WASM module directly with WasmKit
        let module = try parseWasm(filePath: FilePath(wasmPath))
        
        // Extract imports and their types
        var imports: [(module: String, name: String, params: [String], results: [String])] = []
        
        for imp in module.imports {
            if case .function(let typeIndex) = imp.descriptor {
                let funcType = module.types[Int(typeIndex)]
                
                let params = funcType.parameters.map { valueTypeToString($0) }
                let results = funcType.results.map { valueTypeToString($0) }
                
                imports.append((module: imp.module, name: imp.name, params: params, results: results))
            }
        }
        
        if showSummary {
            printSummary(imports: imports)
        } else if generateSwift {
            print(generateSwiftFile(imports: imports))
        } else {
            print(generateStubs(imports: imports))
        }
    }
    
    static func generateSwiftFile(imports: [(module: String, name: String, params: [String], results: [String])]) -> String {
        var output = """
        // WASISignatures.swift
        // Auto-generated from WASM module - DO NOT EDIT
        // Regenerate with: cd scripts/codegen && swift run generate-wasi-stubs <wasm-file> --swift
        
        import WasmKit
        
        /// WASI import signature definitions extracted from the WASM module.
        /// Use these to define imports with correct signatures.
        enum WASISignatures {
            
            typealias Signature = (parameters: [ValueType], results: [ValueType])
            
        """
        
        // Group by module
        var byModule: [String: [(name: String, params: [String], results: [String])]] = [:]
        for imp in imports {
            byModule[imp.module, default: []].append((imp.name, imp.params, imp.results))
        }
        
        for (module, moduleImports) in byModule.sorted(by: { $0.key < $1.key }) {
            let sanitizedModule = sanitizeIdentifier(module)
            output += "    // MARK: - \(module)\n"
            output += "    enum \(sanitizedModule) {\n"
            
            for imp in moduleImports {
                let sanitizedName = sanitizeIdentifier(imp.name)
                let paramsStr = imp.params.isEmpty ? "[]" : "[\(imp.params.map(toSwiftType).joined(separator: ", "))]"
                let resultsStr = imp.results.isEmpty ? "[]" : "[\(imp.results.map(toSwiftType).joined(separator: ", "))]"
                
                output += "        /// `\(imp.name)`: (\(imp.params.joined(separator: ", "))) -> (\(imp.results.joined(separator: ", ")))\n"
                output += "        static let \(sanitizedName): Signature = (\(paramsStr), \(resultsStr))\n"
            }
            
            output += "    }\n\n"
        }
        
        output += "}\n"
        return output
    }
    
    static func sanitizeIdentifier(_ name: String) -> String {
        var result = name
            .replacingOccurrences(of: "wasi:", with: "")
            .replacingOccurrences(of: "@", with: "_")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ".", with: "_")
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: "[", with: "")
            .replacingOccurrences(of: "]", with: "")
        
        // Handle reserved words
        if ["get", "set", "static", "class", "struct", "enum"].contains(result) {
            result = "`\(result)`"
        }
        
        return result
    }
    
    static func valueTypeToString(_ type: ValueType) -> String {
        switch type {
        case .i32: return "i32"
        case .i64: return "i64"
        case .f32: return "f32"
        case .f64: return "f64"
        default: return "unknown"
        }
    }
    
    static func toSwiftType(_ wasmType: String) -> String {
        switch wasmType {
        case "i32": return ".i32"
        case "i64": return ".i64"
        case "f32": return ".f32"
        case "f64": return ".f64"
        default: return ".\(wasmType)"
        }
    }
    
    static func generateStubs(imports: [(module: String, name: String, params: [String], results: [String])]) -> String {
        var output = """
        // Auto-generated WASI import stubs for WasmKit
        // Regenerate with: cd scripts/codegen && swift run generate-wasi-stubs <wasm-file>
        
        import WasmKit
        
        // MARK: - Expected WASI Import Signatures
        
        """
        
        // Group by module
        var byModule: [String: [(name: String, params: [String], results: [String])]] = [:]
        for imp in imports {
            byModule[imp.module, default: []].append((imp.name, imp.params, imp.results))
        }
        
        for (module, moduleImports) in byModule.sorted(by: { $0.key < $1.key }) {
            output += "// ========== \(module) ==========\n\n"
            
            for imp in moduleImports {
                let paramsStr = imp.params.isEmpty ? "[]" : "[\(imp.params.map(toSwiftType).joined(separator: ", "))]"
                let resultsStr = imp.results.isEmpty ? "[]" : "[\(imp.results.map(toSwiftType).joined(separator: ", "))]"
                
                let defaultReturn: String
                if imp.results.isEmpty {
                    defaultReturn = "[]"
                } else {
                    let vals = imp.results.map { ".\($0)(0)" }
                    defaultReturn = "[\(vals.joined(separator: ", "))]"
                }
                
                output += """
                // \(imp.name)
                // Signature: (\(imp.params.joined(separator: ", "))) -> (\(imp.results.joined(separator: ", ")))
                imports.define(module: "\(module)", name: "\(imp.name)",
                    Function(store: store, parameters: \(paramsStr), results: \(resultsStr)) { caller, args in
                        return \(defaultReturn)
                    }
                )
                
                """
            }
        }
        
        return output
    }
    
    static func printSummary(imports: [(module: String, name: String, params: [String], results: [String])]) {
        print("""
        
        WASM Import Signature Summary
        =============================
        
        """)
        
        // Group by module
        var byModule: [String: [(name: String, params: [String], results: [String])]] = [:]
        for imp in imports {
            byModule[imp.module, default: []].append((imp.name, imp.params, imp.results))
        }
        
        for (module, moduleImports) in byModule.sorted(by: { $0.key < $1.key }) {
            print("## \(module)\n")
            print("| Name | Params | Results |")
            print("|------|--------|---------|")
            
            for imp in moduleImports {
                let paramsStr = imp.params.isEmpty ? "(none)" : imp.params.joined(separator: ", ")
                let resultsStr = imp.results.isEmpty ? "(none)" : imp.results.joined(separator: ", ")
                print("| `\(imp.name)` | \(paramsStr) | \(resultsStr) |")
            }
            print("")
        }
    }
}
