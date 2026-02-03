// Swift Protocol Generator
// Generates Swift protocols from parsed WIT interfaces

import WITParser

/// Configuration for Swift code generation
public struct SwiftGenConfig: Sendable {
    /// Whether to generate async methods
    public var useAsync: Bool = true
    
    /// Error type to use in typed throws
    public var errorTypeName: String = "WASIError"
    
    /// Whether to generate WasmKit imports registration
    public var generateImports: Bool = true
    
    /// Module prefix for generated code
    public var modulePrefix: String = "Generated"
    
    public init() {}
}

/// Generates Swift code from WIT documents
public struct SwiftProtocolGenerator: Sendable {
    private let config: SwiftGenConfig
    
    public init(config: SwiftGenConfig = SwiftGenConfig()) {
        self.config = config
    }
    
    /// Generate Swift code for a WIT document
    public func generate(from document: WITDocument) -> String {
        var output = fileHeader(package: document.package)
        
        // Generate types for each interface
        for item in document.items {
            switch item {
            case .interface(let iface):
                output += generateInterface(iface, package: document.package)
            case .world:
                // Skip worlds for now
                break
            case .typeAlias(let alias):
                output += generateTypeAlias(alias)
            case .use:
                // Skip use statements (handled by resolution)
                break
            }
        }
        
        return output
    }
    
    // MARK: - Interface Generation
    
    private func generateInterface(_ iface: WITInterface, package: WITPackage?) -> String {
        var output = ""
        let protocolName = swiftTypeName(iface.name) + "Interface"
        
        // Generate types defined in interface
        for item in iface.items {
            switch item {
            case .record(let record):
                output += generateRecord(record)
            case .variant(let variant):
                output += generateVariant(variant)
            case .enumType(let enumType):
                output += generateEnum(enumType)
            case .flags(let flags):
                output += generateFlags(flags)
            case .typeAlias(let alias):
                output += generateTypeAlias(alias)
            default:
                break
            }
        }
        
        // Generate resource protocols
        for item in iface.items {
            if case .resource(let resource) = item {
                output += generateResourceProtocol(resource)
            }
        }
        
        // Generate main interface protocol
        if iface.docs != nil {
            output += "/// \(iface.docs!)\n"
        }
        output += "public protocol \(protocolName): AnyObject, Sendable {\n"
        
        // Generate function requirements
        for item in iface.items {
            if case .function(let function) = item {
                output += generateFunctionRequirement(function)
            }
        }
        
        output += "}\n\n"
        
        return output
    }
    
    // MARK: - Resource Protocol Generation
    
    private func generateResourceProtocol(_ resource: WITResource) -> String {
        var output = ""
        let protocolName = swiftTypeName(resource.name) + "Resource"
        
        if let docs = resource.docs {
            output += "/// \(docs)\n"
        }
        output += "public protocol \(protocolName): AnyObject, Sendable {\n"
        
        for method in resource.methods {
            output += generateMethodRequirement(method)
        }
        
        output += "}\n\n"
        return output
    }
    
    private func generateMethodRequirement(_ method: WITResourceMethod) -> String {
        var output = ""
        
        if let docs = method.docs {
            output += "    /// \(docs)\n"
        }
        
        let asyncPrefix = config.useAsync ? "async " : ""
        let throwsClause = "throws(\(config.errorTypeName)) "
        
        let params = method.params.map { param in
            "\(swiftParamName(param.name)): \(swiftType(param.type))"
        }.joined(separator: ", ")
        
        let returnType = swiftResultType(method.results)
        let returnClause = returnType.isEmpty ? "" : " -> \(returnType)"
        
        let funcName = swiftFunctionName(method.name)
        
        switch method.kind {
        case .constructor:
            output += "    init(\(params)) \(asyncPrefix)\(throwsClause)\n"
        case .static:
            output += "    static func \(funcName)(\(params)) \(asyncPrefix)\(throwsClause)\(returnClause)\n"
        case .instance:
            output += "    func \(funcName)(\(params)) \(asyncPrefix)\(throwsClause)\(returnClause)\n"
        }
        
        return output
    }
    
    // MARK: - Function Generation
    
    private func generateFunctionRequirement(_ function: WITFunction) -> String {
        var output = ""
        
        if let docs = function.docs {
            output += "    /// \(docs)\n"
        }
        
        let asyncPrefix = config.useAsync ? "async " : ""
        let throwsClause = "throws(\(config.errorTypeName)) "
        
        let params = function.params.map { param in
            "\(swiftParamName(param.name)): \(swiftType(param.type))"
        }.joined(separator: ", ")
        
        let returnType = swiftResultType(function.results)
        let returnClause = returnType.isEmpty ? "" : " -> \(returnType)"
        
        let funcName = swiftFunctionName(function.name)
        output += "    func \(funcName)(\(params)) \(asyncPrefix)\(throwsClause)\(returnClause)\n"
        
        return output
    }
    
    // MARK: - Type Generation
    
    private func generateRecord(_ record: WITRecord) -> String {
        var output = ""
        
        if let docs = record.docs {
            output += "/// \(docs)\n"
        }
        
        let typeName = swiftTypeName(record.name)
        output += "public struct \(typeName): Sendable, Equatable {\n"
        
        for field in record.fields {
            output += "    public var \(swiftParamName(field.name)): \(swiftType(field.type))\n"
        }
        
        // Generate init
        let initParams = record.fields.map { field in
            "\(swiftParamName(field.name)): \(swiftType(field.type))"
        }.joined(separator: ", ")
        
        output += "\n    public init(\(initParams)) {\n"
        for field in record.fields {
            let name = swiftParamName(field.name)
            output += "        self.\(name) = \(name)\n"
        }
        output += "    }\n"
        
        output += "}\n\n"
        return output
    }
    
    private func generateVariant(_ variant: WITVariant) -> String {
        var output = ""
        
        if let docs = variant.docs {
            output += "/// \(docs)\n"
        }
        
        let typeName = swiftTypeName(variant.name)
        output += "public enum \(typeName): Sendable, Equatable {\n"
        
        for caseItem in variant.cases {
            let caseName = swiftCaseName(caseItem.name)
            if let caseType = caseItem.type {
                output += "    case \(caseName)(\(swiftType(caseType)))\n"
            } else {
                output += "    case \(caseName)\n"
            }
        }
        
        output += "}\n\n"
        return output
    }
    
    private func generateEnum(_ enumType: WITEnum) -> String {
        var output = ""
        
        if let docs = enumType.docs {
            output += "/// \(docs)\n"
        }
        
        let typeName = swiftTypeName(enumType.name)
        output += "public enum \(typeName): String, Sendable, CaseIterable {\n"
        
        for caseName in enumType.cases {
            let swiftCase = swiftCaseName(caseName)
            output += "    case \(swiftCase) = \"\(caseName)\"\n"
        }
        
        output += "}\n\n"
        return output
    }
    
    private func generateFlags(_ flags: WITFlags) -> String {
        var output = ""
        
        if let docs = flags.docs {
            output += "/// \(docs)\n"
        }
        
        let typeName = swiftTypeName(flags.name)
        output += "public struct \(typeName): OptionSet, Sendable {\n"
        output += "    public let rawValue: UInt32\n"
        output += "    public init(rawValue: UInt32) { self.rawValue = rawValue }\n\n"
        
        for (i, flag) in flags.flags.enumerated() {
            let flagName = swiftCaseName(flag)
            output += "    public static let \(flagName) = \(typeName)(rawValue: 1 << \(i))\n"
        }
        
        output += "}\n\n"
        return output
    }
    
    private func generateTypeAlias(_ alias: WITTypeAlias) -> String {
        let typeName = swiftTypeName(alias.name)
        let targetType = swiftType(alias.type)
        return "public typealias \(typeName) = \(targetType)\n\n"
    }
    
    // MARK: - Helpers
    
    private func fileHeader(package: WITPackage?) -> String {
        var output = """
        // AUTO-GENERATED from WIT files - DO NOT EDIT
        // Regenerate by building the project or running: swift package plugin wasmkit-bindgen
        
        import Foundation
        
        
        """
        
        if let pkg = package {
            output += "// Package: \(pkg.fullName)\n\n"
        }
        
        return output
    }
    
    private func swiftTypeName(_ witName: String) -> String {
        witName.split(separator: "-")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined()
    }
    
    private func swiftFunctionName(_ witName: String) -> String {
        let parts = witName.split(separator: "-")
        guard let first = parts.first else { return witName }
        return first.lowercased() + parts.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
    }
    
    private func swiftParamName(_ witName: String) -> String {
        swiftFunctionName(witName)
    }
    
    private func swiftCaseName(_ witName: String) -> String {
        swiftFunctionName(witName)
    }
    
    private func swiftType(_ witType: WITType) -> String {
        switch witType {
        case .bool: return "Bool"
        case .u8: return "UInt8"
        case .u16: return "UInt16"
        case .u32: return "UInt32"
        case .u64: return "UInt64"
        case .s8: return "Int8"
        case .s16: return "Int16"
        case .s32: return "Int32"
        case .s64: return "Int64"
        case .f32: return "Float"
        case .f64: return "Double"
        case .char: return "Character"
        case .string: return "String"
        case .list(let inner): return "[\(swiftType(inner))]"
        case .option(let inner): return "\(swiftType(inner))?"
        case .result(let ok, let err):
            let okType = ok.map { swiftType($0) } ?? "()"
            let errType = err.map { swiftType($0) } ?? config.errorTypeName
            return "Result<\(okType), \(errType)>"
        case .tuple(let types):
            return "(\(types.map { swiftType($0) }.joined(separator: ", ")))"
        case .own(let name): return swiftTypeName(name)
        case .borrow(let name): return swiftTypeName(name)
        case .named(let name): return swiftTypeName(name)
        }
    }
    
    private func swiftResultType(_ results: WITResults?) -> String {
        guard let results = results else { return "" }
        
        switch results {
        case .single(let type):
            return swiftType(type)
        case .named(let params):
            if params.isEmpty { return "" }
            if params.count == 1 { return swiftType(params[0].type) }
            return "(\(params.map { "\(swiftParamName($0.name)): \(swiftType($0.type))" }.joined(separator: ", ")))"
        }
    }
}
