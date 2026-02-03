/// WASIProvider.swift
/// Type-safe protocol for WASI import providers with validation support.
///
/// Each provider declares its imports at compile time, allowing pre-instantiation
/// validation to catch missing imports before runtime errors occur.

import WasmKit

/// Represents a single WASI import declaration
struct WASIImportDeclaration: Hashable {
    let module: String
    let name: String
    let parameters: [ValueType]
    let results: [ValueType]
    
    var description: String {
        "\(module).\(name)"
    }
}

/// Protocol for type-safe WASI providers that declare their imports
protocol WASIProvider {
    /// The WASI module(s) this provider handles
    static var moduleName: String { get }
    
    /// All imports this provider declares and registers
    /// This enables compile-time checking and pre-instantiation validation
    var declaredImports: [WASIImportDeclaration] { get }
    
    /// Register all imports into the WasmKit Imports structure
    func register(into imports: inout Imports, store: Store)
}

/// Default implementation for providers that don't yet declare imports
extension WASIProvider {
    var declaredImports: [WASIImportDeclaration] { [] }
}

/// Utility for validating provider coverage against WASM module requirements
struct WASIProviderValidator {
    
    /// Check if all required imports from a WASM module are covered by providers
    static func validate(
        module: Module,
        providers: [WASIProvider]
    ) -> ValidationResult {
        var allDeclared = Set<String>()
        for provider in providers {
            for decl in provider.declaredImports {
                allDeclared.insert(decl.description)
            }
        }
        
        var missing: [String] = []
        for importEntry in module.imports {
            let key = "\(importEntry.module).\(importEntry.name)"
            if !allDeclared.contains(key) {
                missing.append(key)
            }
        }
        
        if missing.isEmpty {
            return .success
        } else {
            return .missingImports(missing)
        }
    }
    
    enum ValidationResult {
        case success
        case missingImports([String])
        
        var isValid: Bool {
            if case .success = self { return true }
            return false
        }
        
        var missingList: [String] {
            if case .missingImports(let list) = self { return list }
            return []
        }
    }
}

/// Extension to make validation easy to use
extension Array where Element == WASIProvider {
    func validate(against module: Module) -> WASIProviderValidator.ValidationResult {
        WASIProviderValidator.validate(module: module, providers: self)
    }
}
