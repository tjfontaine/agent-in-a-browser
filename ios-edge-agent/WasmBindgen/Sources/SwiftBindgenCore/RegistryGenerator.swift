// WasmKit Import Registry Generator
// Generates type-safe import registration code

import WITParser

/// Generates WasmKit import registration providers
public struct ImportRegistryGenerator: Sendable {
    private let config: SwiftGenConfig
    
    public init(config: SwiftGenConfig = SwiftGenConfig()) {
        self.config = config
    }
    
    /// Generate provider implementation for an interface
    public func generateProvider(for iface: WITInterface, package: WITPackage?) -> String {
        let interfaceName = swiftTypeName(iface.name)
        let providerName = interfaceName + "Provider"
        let protocolName = interfaceName + "Interface"
        
        let moduleName = package.map { formatModuleName($0, iface.name) } ?? "unknown"
        
        var output = """
        // MARK: - \(interfaceName) Provider
        
        /// Provides WasmKit imports for \(iface.name) interface
        public struct \(providerName): WASIImportProvider {
            public let implementation: any \(protocolName)
            
            public init(implementation: any \(protocolName)) {
                self.implementation = implementation
            }
            
            public func register(into imports: inout Imports, store: Store, memory: @escaping () -> Memory?) {
                let module = "\(moduleName)"
                
        
        """
        
        // Generate function registrations
        for item in iface.items {
            if case .function(let function) = item {
                output += generateFunctionRegistration(function, moduleName: moduleName)
            }
        }
        
        // Generate resource method registrations
        for item in iface.items {
            if case .resource(let resource) = item {
                output += generateResourceRegistrations(resource, moduleName: moduleName)
            }
        }
        
        output += """
            }
        }
        
        
        """
        
        return output
    }
    
    // MARK: - Function Registration
    
    private func generateFunctionRegistration(_ function: WITFunction, moduleName: String) -> String {
        let signature = generateSignature(function.params, function.results)
        let funcName = function.name
        let swiftName = swiftFunctionName(funcName)
        
        var output = """
                // \(funcName): \(signatureComment(function.params, function.results))
                imports.define(module: module, name: "\(funcName)",
                    Function(store: store, parameters: \(signature.params), results: \(signature.results)) { [impl = implementation] caller, args in
        
        """
        
        // Generate parameter extraction
        var argIndex = 0
        for param in function.params {
            output += generateParamExtraction(param, index: &argIndex)
        }
        
        // Generate call
        let callParams = function.params.map { swiftParamName($0.name) }.joined(separator: ", ")
        
        if function.results != nil {
            output += """
                        do {
                            let result = try await impl.\(swiftName)(\(callParams))
                            return \(generateResultReturn(function.results!))
                        } catch {
                            return \(generateErrorReturn(function.results!))
                        }
            
            """
        } else {
            output += """
                        do {
                            try await impl.\(swiftName)(\(callParams))
                            return []
                        } catch {
                            return []
                        }
            
            """
        }
        
        output += """
                    }
                )
        
        """
        
        return output
    }
    
    // MARK: - Resource Registration
    
    private func generateResourceRegistrations(_ resource: WITResource, moduleName: String) -> String {
        let resourceName = resource.name
        var output = ""
        
        for method in resource.methods {
            let witName: String
            switch method.kind {
            case .constructor:
                witName = "[constructor]\(resourceName)"
            case .static:
                witName = "[static]\(resourceName).\(method.name)"
            case .instance:
                witName = "[method]\(resourceName).\(method.name)"
            }
            
            let signature = generateSignature(method.params, method.results, isMethod: method.kind == .instance)
            
            output += """
                // \(witName)
                imports.define(module: module, name: "\(witName)",
                    Function(store: store, parameters: \(signature.params), results: \(signature.results)) { caller, args in
                        // TODO: Implement resource method dispatch
                        return \(generateDefaultReturn(method.results))
                    }
                )
        
        """
        }
        
        // Resource drop
        output += """
                // [resource-drop]\(resourceName)
                imports.define(module: module, name: "[resource-drop]\(resourceName)",
                    Function(store: store, parameters: [.i32], results: []) { caller, args in
                        // TODO: Implement resource cleanup
                        return []
                    }
                )
        
        """
        
        return output
    }
    
    // MARK: - Signature Generation
    
    private struct Signature {
        var params: String
        var results: String
    }
    
    private func generateSignature(_ params: [WITParam], _ results: WITResults?, isMethod: Bool = false) -> Signature {
        var wasmParams: [String] = []
        
        // Methods have implicit self handle as first param
        if isMethod {
            wasmParams.append(".i32")
        }
        
        for param in params {
            wasmParams += wasmParamTypes(param.type)
        }
        
        var wasmResults: [String] = []
        if let results = results {
            wasmResults = wasmResultTypes(results)
        }
        
        let paramsStr = wasmParams.isEmpty ? "[]" : "[\(wasmParams.joined(separator: ", "))]"
        let resultsStr = wasmResults.isEmpty ? "[]" : "[\(wasmResults.joined(separator: ", "))]"
        
        return Signature(params: paramsStr, results: resultsStr)
    }
    
    private func wasmParamTypes(_ type: WITType) -> [String] {
        switch type {
        case .bool, .u8, .s8, .u16, .s16, .u32, .s32, .char:
            return [".i32"]
        case .u64, .s64:
            return [".i64"]
        case .f32:
            return [".f32"]
        case .f64:
            return [".f64"]
        case .string:
            // ptr, len
            return [".i32", ".i32"]
        case .list:
            // ptr, len
            return [".i32", ".i32"]
        case .option(let inner):
            // discriminant + inner
            return [".i32"] + wasmParamTypes(inner)
        case .result(let ok, _):
            // discriminant + ok type
            var result = [".i32"]
            if let ok = ok {
                result += wasmParamTypes(ok)
            }
            return result
        case .tuple(let types):
            return types.flatMap { wasmParamTypes($0) }
        case .own, .borrow, .named:
            // Handle (resource reference)
            return [".i32"]
        }
    }
    
    private func wasmResultTypes(_ results: WITResults) -> [String] {
        switch results {
        case .single(let type):
            return wasmParamTypes(type)
        case .named(let params):
            return params.flatMap { wasmParamTypes($0.type) }
        }
    }
    
    private func signatureComment(_ params: [WITParam], _ results: WITResults?) -> String {
        let paramStr = params.map { witTypeName($0.type) }.joined(separator: ", ")
        let resultStr: String
        if let results = results {
            switch results {
            case .single(let type):
                resultStr = witTypeName(type)
            case .named(let params):
                resultStr = "(\(params.map { "\($0.name): \(witTypeName($0.type))" }.joined(separator: ", ")))"
            }
        } else {
            resultStr = "()"
        }
        return "(\(paramStr)) -> \(resultStr)"
    }
    
    private func witTypeName(_ type: WITType) -> String {
        switch type {
        case .bool: return "bool"
        case .u8: return "u8"
        case .u16: return "u16"
        case .u32: return "u32"
        case .u64: return "u64"
        case .s8: return "s8"
        case .s16: return "s16"
        case .s32: return "s32"
        case .s64: return "s64"
        case .f32: return "f32"
        case .f64: return "f64"
        case .char: return "char"
        case .string: return "string"
        case .list(let inner): return "list<\(witTypeName(inner))>"
        case .option(let inner): return "option<\(witTypeName(inner))>"
        case .result(let ok, let err):
            let okStr = ok.map { witTypeName($0) } ?? "_"
            let errStr = err.map { witTypeName($0) } ?? "_"
            return "result<\(okStr), \(errStr)>"
        case .tuple(let types): return "tuple<\(types.map { witTypeName($0) }.joined(separator: ", "))>"
        case .own(let name): return "own<\(name)>"
        case .borrow(let name): return "borrow<\(name)>"
        case .named(let name): return name
        }
    }
    
    // MARK: - Parameter Extraction
    
    private func generateParamExtraction(_ param: WITParam, index: inout Int) -> String {
        let name = swiftParamName(param.name)
        
        switch param.type {
        case .u32, .s32, .bool, .u8, .s8, .u16, .s16, .char:
            let result = "            let \(name) = args[\(index)].i32\n"
            index += 1
            return result
        case .u64, .s64:
            let result = "            let \(name) = args[\(index)].i64\n"
            index += 1
            return result
        case .string:
            let result = """
                        let \(name)Ptr = UInt(args[\(index)].i32)
                        let \(name)Len = Int(args[\(index + 1)].i32)
                        let \(name) = memory()?.readString(offset: \(name)Ptr, length: \(name)Len) ?? ""
            
            """
            index += 2
            return result
        case .list:
            let result = """
                        let \(name)Ptr = UInt(args[\(index)].i32)
                        let \(name)Len = Int(args[\(index + 1)].i32)
                        // TODO: Read list from memory
                        let \(name): [UInt8] = []
            
            """
            index += 2
            return result
        default:
            let result = "            let \(name) = args[\(index)].i32  // TODO: Handle complex type\n"
            index += 1
            return result
        }
    }
    
    // MARK: - Return Generation
    
    private func generateResultReturn(_ results: WITResults) -> String {
        switch results {
        case .single(let type):
            return generateValueReturn(type, varName: "result")
        case .named(let params):
            if params.count == 1 {
                return generateValueReturn(params[0].type, varName: "result")
            }
            // Multi-value return
            return "[]  // TODO: Handle multi-value return"
        }
    }
    
    private func generateValueReturn(_ type: WITType, varName: String) -> String {
        switch type {
        case .u32, .s32, .bool, .u8, .s8, .u16, .s16, .char:
            return "[.i32(UInt32(bitPattern: Int32(\(varName))))]"
        case .u64, .s64:
            return "[.i64(UInt64(bitPattern: Int64(\(varName))))]"
        case .f32:
            return "[.f32(\(varName))]"
        case .f64:
            return "[.f64(\(varName))]"
        default:
            return "[.i32(0)]  // TODO: Handle complex return type"
        }
    }
    
    private func generateErrorReturn(_ results: WITResults) -> String {
        switch results {
        case .single(let type):
            return generateDefaultValue(type)
        case .named(let params):
            if params.count == 1 {
                return generateDefaultValue(params[0].type)
            }
            return "[]"
        }
    }
    
    private func generateDefaultReturn(_ results: WITResults?) -> String {
        guard let results = results else { return "[]" }
        return generateErrorReturn(results)
    }
    
    private func generateDefaultValue(_ type: WITType) -> String {
        switch type {
        case .u32, .s32, .bool, .u8, .s8, .u16, .s16, .char:
            return "[.i32(0)]"
        case .u64, .s64:
            return "[.i64(0)]"
        case .f32:
            return "[.f32(0)]"
        case .f64:
            return "[.f64(0)]"
        default:
            return "[.i32(0)]"
        }
    }
    
    // MARK: - Helpers
    
    private func formatModuleName(_ package: WITPackage, _ interfaceName: String) -> String {
        var result = "\(package.namespace):\(package.name)/\(interfaceName)"
        if let version = package.version {
            result += "@\(version)"
        }
        return result
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
}
