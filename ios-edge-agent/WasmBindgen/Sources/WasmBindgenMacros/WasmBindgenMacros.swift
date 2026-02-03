// WasmBindgen Swift Macros
// Type-safe macros for WASI import registration

import SwiftCompilerPlugin
import SwiftSyntax
import SwiftSyntaxBuilder
import SwiftSyntaxMacros

// MARK: - Plugin Entry Point

@main
struct WasmBindgenMacroPlugin: CompilerPlugin {
    let providingMacros: [Macro.Type] = [
        WASIImportMacro.self,
        WASIResourceMacro.self,
        WASIFunctionMacro.self,
        WASIProviderMacro.self,
        WASIImportFuncMacro.self,
    ]
}

// MARK: - @WASIImport Macro

/// Generates type-safe WasmKit import registrations from a protocol conformance.
///
/// Usage:
/// ```swift
/// @WASIImport(module: "wasi:io/streams@0.2.0")
/// struct MyStreamsProvider: StreamsResource {
///     func read(len: UInt64) async throws(WASIError) -> [UInt8] { ... }
/// }
/// ```
///
/// Expands to register the import with WasmKit using correct signatures.
public struct WASIImportMacro: MemberMacro, ExtensionMacro {
    
    public static func expansion(
        of node: AttributeSyntax,
        providingMembersOf declaration: some DeclGroupSyntax,
        conformingTo protocols: [TypeSyntax],
        in context: some MacroExpansionContext
    ) throws -> [DeclSyntax] {
        // Extract module name from attribute
        guard let arguments = node.arguments?.as(LabeledExprListSyntax.self),
              let moduleArg = arguments.first(where: { $0.label?.text == "module" }),
              let moduleLiteral = moduleArg.expression.as(StringLiteralExprSyntax.self),
              let moduleSegment = moduleLiteral.segments.first?.as(StringSegmentSyntax.self) else {
            throw MacroError.missingModuleArgument
        }
        
        let moduleName = moduleSegment.content.text
        
        // Generate the register method
        let registerMethod: DeclSyntax = """
        /// Register this provider's imports into a WasmKit Imports instance
        public func register(into imports: inout Imports, store: Store, memory: @escaping () -> Memory?) {
            Self.registerImports(into: &imports, store: store, memory: memory, provider: self)
        }
        """
        
        // Generate static registration helper
        let staticHelper: DeclSyntax = """
        /// Static registration helper for protocol-based providers
        public static func registerImports<T: WASIImportProvider>(
            into imports: inout Imports,
            store: Store,
            memory: @escaping () -> Memory?,
            provider: T
        ) {
            // Registration is generated based on protocol conformance
            // This will be filled in by the protocol generator
        }
        """
        
        return [registerMethod, staticHelper]
    }
    
    public static func expansion(
        of node: AttributeSyntax,
        attachedTo declaration: some DeclGroupSyntax,
        providingExtensionsOf type: some TypeSyntaxProtocol,
        conformingTo protocols: [TypeSyntax],
        in context: some MacroExpansionContext
    ) throws -> [ExtensionDeclSyntax] {
        // Add WASIImportProvider conformance
        let ext = try ExtensionDeclSyntax("extension \(type): WASIImportProvider {}")
        return [ext]
    }
}

// MARK: - @WASIResource Macro

/// Marks a class as a WASI resource implementation with automatic handle management.
///
/// Usage:
/// ```swift
/// @WASIResource
/// final class InputStreamImpl: InputStreamResource {
///     func read(len: UInt64) async throws(WASIError) -> [UInt8] { ... }
/// }
/// ```
public struct WASIResourceMacro: MemberMacro {
    
    public static func expansion(
        of node: AttributeSyntax,
        providingMembersOf declaration: some DeclGroupSyntax,
        conformingTo protocols: [TypeSyntax],
        in context: some MacroExpansionContext
    ) throws -> [DeclSyntax] {
        // Generate handle tracking
        let handleProperty: DeclSyntax = """
        /// Internal handle for WasmKit resource tracking
        private var _wasmHandle: Int32 = -1
        """
        
        let handleGetter: DeclSyntax = """
        /// Get the WASM handle for this resource
        public var wasmHandle: Int32 {
            get { _wasmHandle }
            set { _wasmHandle = newValue }
        }
        """
        
        return [handleProperty, handleGetter]
    }
}

// MARK: - @WASIFunction Macro

/// Generates type-safe function wrappers for WASI imports.
///
/// Usage:
/// ```swift
/// @WASIFunction(name: "read", params: [.i32, .i32], results: [.i32])
/// func read(fd: Int32, len: Int32) -> Int32 { ... }
/// ```
public struct WASIFunctionMacro: PeerMacro {
    
    public static func expansion(
        of node: AttributeSyntax,
        providingPeersOf declaration: some DeclSyntaxProtocol,
        in context: some MacroExpansionContext
    ) throws -> [DeclSyntax] {
        guard let funcDecl = declaration.as(FunctionDeclSyntax.self) else {
            throw MacroError.notAFunction
        }
        
        let funcName = funcDecl.name.text
        
        // Generate the WasmKit Function wrapper
        let wrapper: DeclSyntax = """
        /// WasmKit function wrapper for \(raw: funcName)
        private func _wasm_\(raw: funcName)(caller: Caller, args: [Value]) -> [Value] {
            // Type-safe argument extraction generated here
            fatalError("Macro expansion incomplete - use code generator")
        }
        """
        
        return [wrapper]
    }
}

// MARK: - Macro Errors

enum MacroError: Error, CustomStringConvertible {
    case missingModuleArgument
    case notAFunction
    case invalidSignature
    
    var description: String {
        switch self {
        case .missingModuleArgument:
            return "@WASIImport requires a 'module' argument"
        case .notAFunction:
            return "@WASIFunction can only be applied to functions"
        case .invalidSignature:
            return "Invalid WASI function signature"
        }
    }
}
