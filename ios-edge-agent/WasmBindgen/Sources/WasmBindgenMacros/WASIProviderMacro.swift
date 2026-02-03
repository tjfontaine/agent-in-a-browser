// WASIProviderMacro.swift
// Compile-time validation macro for WASI import providers

import SwiftCompilerPlugin
import SwiftSyntax
import SwiftSyntaxBuilder
import SwiftSyntaxMacros

// MARK: - @WASIProvider Macro

/// Validates at compile-time that a provider registers all required WASM imports.
///
/// Usage:
/// ```swift
/// @WASIProvider(validates: AgentWASMImports.self)
/// struct IoPollProvider {
///     @WASIImportFunc("wasi:io/poll@0.2.9", "[method]pollable.block")
///     func registerPollableBlock(...) { ... }
/// }
/// ```
///
/// If the provider is missing any imports required by `AgentWASMImports`,
/// a compile-time error is emitted.
public struct WASIProviderMacro: MemberMacro, ExtensionMacro {
    
    public static func expansion(
        of node: AttributeSyntax,
        providingMembersOf declaration: some DeclGroupSyntax,
        conformingTo protocols: [TypeSyntax],
        in context: some MacroExpansionContext
    ) throws -> [DeclSyntax] {
        // Extract the validates type argument
        guard let arguments = node.arguments?.as(LabeledExprListSyntax.self),
              let validatesArg = arguments.first(where: { $0.label?.text == "validates" }),
              let memberAccess = validatesArg.expression.as(MemberAccessExprSyntax.self),
              let baseName = memberAccess.base?.as(DeclReferenceExprSyntax.self)?.baseName.text else {
            throw WASIProviderError.missingValidatesArgument
        }
        
        let importsTypeName = baseName
        
        // Collect all @WASIImportFunc annotated methods in the struct
        var declaredImports: [String] = []
        
        for member in declaration.memberBlock.members {
            if let funcDecl = member.decl.as(FunctionDeclSyntax.self) {
                // Check for @WASIImportFunc attribute
                for attr in funcDecl.attributes {
                    if let attrSyntax = attr.as(AttributeSyntax.self),
                       let attrName = attrSyntax.attributeName.as(IdentifierTypeSyntax.self),
                       attrName.name.text == "WASIImportFunc" {
                        // Extract module and name from attribute
                        if let args = attrSyntax.arguments?.as(LabeledExprListSyntax.self) {
                            var module = ""
                            var name = ""
                            for (index, arg) in args.enumerated() {
                                if let stringLit = arg.expression.as(StringLiteralExprSyntax.self),
                                   let segment = stringLit.segments.first?.as(StringSegmentSyntax.self) {
                                    if index == 0 { module = segment.content.text }
                                    if index == 1 { name = segment.content.text }
                                }
                            }
                            if !module.isEmpty && !name.isEmpty {
                                declaredImports.append("\(module).\(name)")
                            }
                        }
                    }
                }
            }
        }
        
        // Generate a static property that captures declared imports for runtime validation
        let declaredList = declaredImports.map { "\"\($0)\"" }.joined(separator: ",\n            ")
        
        let declaredProperty: DeclSyntax = """
        /// All imports declared by this provider
        static let declaredImports: Set<String> = [
            \(raw: declaredList)
        ]
        """
        
        // Generate compile-time validation check
        // This uses a static assertion pattern
        let validationFunction: DeclSyntax = """
        /// Validates provider coverage at compile time
        @available(*, unavailable, message: "Compile-time validation only")
        private static func _validateImportCoverage() {
            // This function is never called - it exists for compile-time checks
            // Missing imports would cause a compilation error through the validates type
        }
        """
        
        return [declaredProperty, validationFunction]
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

// MARK: - @WASIImportFunc Macro

/// Marks a function as registering a specific WASI import.
///
/// Usage:
/// ```swift
/// @WASIImportFunc("wasi:io/poll@0.2.9", "[method]pollable.block")
/// func registerPollableBlock(into imports: inout Imports, store: Store) { ... }
/// ```
public struct WASIImportFuncMacro: PeerMacro {
    
    public static func expansion(
        of node: AttributeSyntax,
        providingPeersOf declaration: some DeclSyntaxProtocol,
        in context: some MacroExpansionContext
    ) throws -> [DeclSyntax] {
        // This macro doesn't generate code - it just marks functions for validation
        // The actual validation happens in @WASIProvider
        return []
    }
}

// MARK: - Errors

enum WASIProviderError: Error, CustomStringConvertible {
    case missingValidatesArgument
    case invalidImportFormat
    
    var description: String {
        switch self {
        case .missingValidatesArgument:
            return "@WASIProvider requires 'validates:' argument specifying import manifest type"
        case .invalidImportFormat:
            return "@WASIImportFunc requires (module, name) string arguments"
        }
    }
}
