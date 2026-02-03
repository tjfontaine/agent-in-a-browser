// WIT Parser - Builds AST from tokens

/// WIT Parser - converts tokens to AST
public struct WITParser: Sendable {
    private var tokens: [WITToken]
    private var current: Int = 0
    private var pendingDocs: [String] = []
    
    public init(tokens: [WITToken]) {
        self.tokens = tokens
    }
    
    /// Convenience initializer that tokenizes source directly
    public init(source: String) throws {
        var lexer = WITLexer(source: source)
        self.tokens = try lexer.tokenize()
    }
    
    /// Parse a complete WIT document
    public mutating func parse() throws(WITParserError) -> WITDocument {
        var document = WITDocument()
        
        // Parse optional package declaration
        if check(.package) {
            document.package = try parsePackage()
        }
        
        // Parse top-level items
        while !isAtEnd {
            collectDocs()
            
            if isAtEnd { break }
            
            let item = try parseTopLevelItem()
            document.items.append(item)
        }
        
        return document
    }
    
    // MARK: - Top-Level Parsing
    
    private mutating func parsePackage() throws(WITParserError) -> WITPackage {
        try consume(.package, message: "Expected 'package'")
        
        // namespace:name@version
        let namespace = try consumeIdentifier(message: "Expected package namespace")
        try consume(.colon, message: "Expected ':' after namespace")
        let name = try consumeIdentifier(message: "Expected package name")
        
        var version: String? = nil
        // Version can appear as @version (two tokens) or as just an identifier
        // if the lexer consumed @digit as a single identifier
        if match(.at) {
            version = try consumeIdentifier(message: "Expected version")
        } else if case .identifier(let v) = peek().kind, v.first?.isNumber == true {
            // Version number starting with digit (lexer consumed @ and returned version)
            advance()
            version = v
        }
        
        try consume(.semicolon, message: "Expected ';' after package declaration")
        
        return WITPackage(namespace: namespace, name: name, version: version)
    }
    
    private mutating func parseTopLevelItem() throws(WITParserError) -> WITItem {
        let docs = consumePendingDocs()
        
        if check(.interface) {
            var iface = try parseInterface()
            iface.docs = docs
            return .interface(iface)
        }
        
        if check(.world) {
            var world = try parseWorld()
            world.docs = docs
            return .world(world)
        }
        
        if check(.type) {
            return .typeAlias(try parseTypeAlias())
        }
        
        if check(.use) {
            return .use(try parseUse())
        }
        
        throw WITParserError.unexpectedToken(peek(), expected: "interface, world, type, or use")
    }
    
    // MARK: - Interface Parsing
    
    private mutating func parseInterface() throws(WITParserError) -> WITInterface {
        try consume(.interface, message: "Expected 'interface'")
        let name = try consumeIdentifier(message: "Expected interface name")
        try consume(.lBrace, message: "Expected '{' after interface name")
        
        var items: [WITInterfaceItem] = []
        
        while !check(.rBrace) && !isAtEnd {
            collectDocs()
            if check(.rBrace) { break }
            
            let item = try parseInterfaceItem()
            items.append(item)
        }
        
        try consume(.rBrace, message: "Expected '}' after interface body")
        
        return WITInterface(name: name, items: items)
    }
    
    private mutating func parseInterfaceItem() throws(WITParserError) -> WITInterfaceItem {
        let docs = consumePendingDocs()
        
        if check(.resource) {
            var resource = try parseResource()
            resource.docs = docs
            return .resource(resource)
        }
        
        if check(.record) {
            var record = try parseRecord()
            record.docs = docs
            return .record(record)
        }
        
        if check(.variant) {
            var variant = try parseVariant()
            variant.docs = docs
            return .variant(variant)
        }
        
        if check(.enum) {
            var enumType = try parseEnum()
            enumType.docs = docs
            return .enumType(enumType)
        }
        
        if check(.flags) {
            var flags = try parseFlags()
            flags.docs = docs
            return .flags(flags)
        }
        
        if check(.type) {
            return .typeAlias(try parseTypeAlias())
        }
        
        if check(.use) {
            return .use(try parseUse())
        }
        
        // It's a function
        var function = try parseFunction()
        function.docs = docs
        return .function(function)
    }
    
    // MARK: - Resource Parsing
    
    private mutating func parseResource() throws(WITParserError) -> WITResource {
        try consume(.resource, message: "Expected 'resource'")
        let name = try consumeIdentifier(message: "Expected resource name")
        
        var methods: [WITResourceMethod] = []
        
        if match(.lBrace) {
            while !check(.rBrace) && !isAtEnd {
                collectDocs()
                if check(.rBrace) { break }
                
                let method = try parseResourceMethod()
                methods.append(method)
            }
            try consume(.rBrace, message: "Expected '}' after resource body")
        } else {
            try consume(.semicolon, message: "Expected ';' or '{' after resource name")
        }
        
        return WITResource(name: name, methods: methods)
    }
    
    private mutating func parseResourceMethod() throws(WITParserError) -> WITResourceMethod {
        let docs = consumePendingDocs()
        
        let kind: WITResourceMethod.Kind
        let name: String
        let params: [WITParam]
        var results: WITResults? = nil
        
        if check(.constructor) {
            advance()
            kind = .constructor
            name = "constructor"
            // Constructor uses direct signature: constructor(params...) or constructor() -> result
            let (ctorParams, ctorResults) = try parseFunctionSignature()
            params = ctorParams
            results = ctorResults
            try consume(.semicolon, message: "Expected ';' after constructor")
        } else {
            // Instance or static method: name: [static] func(...)
            name = try consumeIdentifier(message: "Expected method name")
            try consume(.colon, message: "Expected ':' after method name")
            
            if match(.static) {
                kind = .static
            } else {
                kind = .instance
            }
            
            try consume(.func, message: "Expected 'func'")
            let (methodParams, methodResults) = try parseFunctionSignature()
            params = methodParams
            results = methodResults
            try consume(.semicolon, message: "Expected ';' after method")
        }
        
        return WITResourceMethod(kind: kind, name: name, params: params, results: results, docs: docs)
    }
    
    // MARK: - Function Parsing
    
    private mutating func parseFunction() throws(WITParserError) -> WITFunction {
        let name = try consumeIdentifier(message: "Expected function name")
        try consume(.colon, message: "Expected ':' after function name")
        try consume(.func, message: "Expected 'func'")
        
        let (params, results) = try parseFunctionSignature()
        
        try consume(.semicolon, message: "Expected ';' after function")
        
        return WITFunction(name: name, params: params, results: results)
    }
    
    private mutating func parseFunctionSignature() throws(WITParserError) -> ([WITParam], WITResults?) {
        try consume(.lParen, message: "Expected '(' for function parameters")
        
        var params: [WITParam] = []
        while !check(.rParen) && !isAtEnd {
            collectDocs()  // Skip param docs
            if check(.rParen) { break }
            let param = try parseParam()
            params.append(param)
            
            if !check(.rParen) {
                try consume(.comma, message: "Expected ',' between parameters")
            }
        }
        
        try consume(.rParen, message: "Expected ')' after parameters")
        
        // Results
        var results: WITResults? = nil
        if match(.arrow) {
            if check(.lParen) {
                // Named results
                advance()
                var namedResults: [WITParam] = []
                while !check(.rParen) && !isAtEnd {
                    let result = try parseParam()
                    namedResults.append(result)
                    if !check(.rParen) {
                        try consume(.comma, message: "Expected ',' between results")
                    }
                }
                try consume(.rParen, message: "Expected ')' after results")
                results = .named(namedResults)
            } else {
                // Single result type
                let resultType = try parseType()
                results = .single(resultType)
            }
        }
        
        return (params, results)
    }
    
    private mutating func parseParam() throws(WITParserError) -> WITParam {
        let name = try consumeIdentifier(message: "Expected parameter name")
        try consume(.colon, message: "Expected ':' after parameter name")
        let type = try parseType()
        return WITParam(name: name, type: type)
    }
    
    // MARK: - Type Parsing
    
    private mutating func parseType() throws(WITParserError) -> WITType {
        // Primitives
        if match(.bool) { return .bool }
        if match(.u8) { return .u8 }
        if match(.u16) { return .u16 }
        if match(.u32) { return .u32 }
        if match(.u64) { return .u64 }
        if match(.s8) { return .s8 }
        if match(.s16) { return .s16 }
        if match(.s32) { return .s32 }
        if match(.s64) { return .s64 }
        if match(.f32) { return .f32 }
        if match(.f64) { return .f64 }
        if match(.char) { return .char }
        if match(.string) { return .string }
        
        // Generic types
        if match(.list) {
            try consume(.lAngle, message: "Expected '<' after 'list'")
            let inner = try parseType()
            try consume(.rAngle, message: "Expected '>' after list type")
            return .list(inner)
        }
        
        if match(.option) {
            try consume(.lAngle, message: "Expected '<' after 'option'")
            let inner = try parseType()
            try consume(.rAngle, message: "Expected '>' after option type")
            return .option(inner)
        }
        
        if match(.result) {
            var ok: WITType? = nil
            var err: WITType? = nil
            
            if match(.lAngle) {
                // result<ok, err> or result<_, err> or result<ok>
                if match(.`_`) {
                    ok = nil
                } else if !check(.comma) && !check(.rAngle) {
                    ok = try parseType()
                }
                
                if match(.comma) {
                    err = try parseType()
                }
                
                try consume(.rAngle, message: "Expected '>' after result types")
            }
            
            return .result(ok: ok, err: err)
        }
        
        if match(.tuple) {
            try consume(.lAngle, message: "Expected '<' after 'tuple'")
            var types: [WITType] = []
            while !check(.rAngle) && !isAtEnd {
                let type = try parseType()
                types.append(type)
                if !check(.rAngle) {
                    try consume(.comma, message: "Expected ',' between tuple types")
                }
            }
            try consume(.rAngle, message: "Expected '>' after tuple types")
            return .tuple(types)
        }
        
        if match(.own) {
            try consume(.lAngle, message: "Expected '<' after 'own'")
            let name = try consumeIdentifier(message: "Expected resource name")
            try consume(.rAngle, message: "Expected '>' after own type")
            return .own(name)
        }
        
        if match(.borrow) {
            try consume(.lAngle, message: "Expected '<' after 'borrow'")
            let name = try consumeIdentifier(message: "Expected resource name")
            try consume(.rAngle, message: "Expected '>' after borrow type")
            return .borrow(name)
        }
        
        // Named type
        if case .identifier(let name) = peek().kind {
            advance()
            return .named(name)
        }
        
        throw WITParserError.unexpectedToken(peek(), expected: "type")
    }
    
    // MARK: - Record, Variant, Enum, Flags
    
    private mutating func parseRecord() throws(WITParserError) -> WITRecord {
        try consume(.record, message: "Expected 'record'")
        let name = try consumeIdentifier(message: "Expected record name")
        try consume(.lBrace, message: "Expected '{' after record name")
        
        var fields: [WITField] = []
        while !check(.rBrace) && !isAtEnd {
            collectDocs()  // Skip field docs
            if check(.rBrace) { break }
            let fieldName = try consumeIdentifier(message: "Expected field name")
            try consume(.colon, message: "Expected ':' after field name")
            let fieldType = try parseType()
            fields.append(WITField(name: fieldName, type: fieldType))
            
            if !check(.rBrace) {
                try consume(.comma, message: "Expected ',' between fields")
            }
        }
        
        try consume(.rBrace, message: "Expected '}' after record body")
        
        return WITRecord(name: name, fields: fields)
    }
    
    private mutating func parseVariant() throws(WITParserError) -> WITVariant {
        try consume(.variant, message: "Expected 'variant'")
        let name = try consumeIdentifier(message: "Expected variant name")
        try consume(.lBrace, message: "Expected '{' after variant name")
        
        var cases: [WITCase] = []
        while !check(.rBrace) && !isAtEnd {
            collectDocs()  // Skip case docs
            if check(.rBrace) { break }
            let caseName = try consumeIdentifier(message: "Expected case name")
            var caseType: WITType? = nil
            
            if match(.lParen) {
                caseType = try parseType()
                try consume(.rParen, message: "Expected ')' after case type")
            }
            
            cases.append(WITCase(name: caseName, type: caseType))
            
            if !check(.rBrace) {
                try consume(.comma, message: "Expected ',' between cases")
            }
        }
        
        try consume(.rBrace, message: "Expected '}' after variant body")
        
        return WITVariant(name: name, cases: cases)
    }
    
    private mutating func parseEnum() throws(WITParserError) -> WITEnum {
        try consume(.enum, message: "Expected 'enum'")
        let name = try consumeIdentifier(message: "Expected enum name")
        try consume(.lBrace, message: "Expected '{' after enum name")
        
        var cases: [String] = []
        while !check(.rBrace) && !isAtEnd {
            collectDocs()  // Skip case docs
            if check(.rBrace) { break }
            let caseName = try consumeIdentifier(message: "Expected enum case name")
            cases.append(caseName)
            
            if !check(.rBrace) {
                try consume(.comma, message: "Expected ',' between enum cases")
            }
        }
        
        try consume(.rBrace, message: "Expected '}' after enum body")
        
        return WITEnum(name: name, cases: cases)
    }
    
    private mutating func parseFlags() throws(WITParserError) -> WITFlags {
        try consume(.flags, message: "Expected 'flags'")
        let name = try consumeIdentifier(message: "Expected flags name")
        try consume(.lBrace, message: "Expected '{' after flags name")
        
        var flags: [String] = []
        while !check(.rBrace) && !isAtEnd {
            collectDocs()  // Skip flag docs
            if check(.rBrace) { break }
            let flagName = try consumeIdentifier(message: "Expected flag name")
            flags.append(flagName)
            
            if !check(.rBrace) {
                try consume(.comma, message: "Expected ',' between flags")
            }
        }
        
        try consume(.rBrace, message: "Expected '}' after flags body")
        
        return WITFlags(name: name, flags: flags)
    }
    
    private mutating func parseTypeAlias() throws(WITParserError) -> WITTypeAlias {
        try consume(.type, message: "Expected 'type'")
        let name = try consumeIdentifier(message: "Expected type alias name")
        try consume(.equals, message: "Expected '=' after type alias name")
        let type = try parseType()
        try consume(.semicolon, message: "Expected ';' after type alias")
        return WITTypeAlias(name: name, type: type)
    }
    
    // MARK: - Use Statement
    
    private mutating func parseUse() throws(WITParserError) -> WITUse {
        try consume(.use, message: "Expected 'use'")
        
        let path = try parseUsePath()
        
        try consume(.dot, message: "Expected '.' before use items")
        try consume(.lBrace, message: "Expected '{' for use items")
        
        var names: [WITUseItem] = []
        while !check(.rBrace) && !isAtEnd {
            let itemName = try consumeIdentifier(message: "Expected use item name")
            var asName: String? = nil
            
            if match(.as) {
                asName = try consumeIdentifier(message: "Expected 'as' name")
            }
            
            names.append(WITUseItem(name: itemName, as: asName))
            
            if !check(.rBrace) {
                try consume(.comma, message: "Expected ',' between use items")
            }
        }
        
        try consume(.rBrace, message: "Expected '}' after use items")
        try consume(.semicolon, message: "Expected ';' after use statement")
        
        return WITUse(path: path, names: names)
    }
    
    private mutating func parseUsePath() throws(WITParserError) -> WITUsePath {
        let first = try consumeIdentifier(message: "Expected use path")
        
        if match(.colon) {
            // External path: namespace:package/interface@version
            let packageName = try consumeIdentifier(message: "Expected package name after ':'")
            try consume(.slash, message: "Expected '/' after package name")
            let interfaceName = try consumeIdentifier(message: "Expected interface name")
            
            var version: String? = nil
            if match(.at) {
                version = try consumeIdentifier(message: "Expected version")
            } else if case .identifier(let v) = peek().kind, v.first?.isNumber == true {
                // Version number starting with digit (lexer consumed @ and returned version)
                advance()
                version = v
            }
            
            return .external(namespace: first, package: packageName, interface: interfaceName, version: version)
        }
        
        // Local path
        return .local(first)
    }
    
    // MARK: - World Parsing
    
    private mutating func parseWorld() throws(WITParserError) -> WITWorld {
        try consume(.world, message: "Expected 'world'")
        let name = try consumeIdentifier(message: "Expected world name")
        try consume(.lBrace, message: "Expected '{' after world name")
        
        var items: [WITWorldItem] = []
        
        while !check(.rBrace) && !isAtEnd {
            collectDocs()
            if check(.rBrace) { break }
            
            if check(.import) {
                advance()
                items.append(.import(try parseWorldImportExport()))
            } else if check(.export) {
                advance()
                items.append(.export(try parseWorldExport()))
            } else if check(.include) {
                items.append(.include(try parseInclude()))
            } else if check(.type) {
                items.append(.typeAlias(try parseTypeAlias()))
            } else if check(.use) {
                items.append(.use(try parseUse()))
            } else {
                throw WITParserError.unexpectedToken(peek(), expected: "import, export, include, type, or use")
            }
        }
        
        try consume(.rBrace, message: "Expected '}' after world body")
        
        return WITWorld(name: name, items: items)
    }
    
    private mutating func parseWorldImportExport() throws(WITParserError) -> WITImport {
        // Could be:
        // 1. import name: interface { ... }
        // 2. import name: namespace:package/interface;
        // 3. import namespace:package/interface; (direct path, no custom name)
        
        let first = try consumeIdentifier(message: "Expected import name or namespace")
        
        if match(.colon) {
            // Could be "name: ..." or "namespace:package/..."
            if check(.interface) {
                // Case 1: name: interface { ... }
                let iface = try parseInterface()
                return WITImport(name: first, inline: iface)
            }
            
            // Check if next token starts a path (identifier) or is part of path
            let second = try consumeIdentifier(message: "Expected path or package name")
            
            if match(.slash) {
                // Case 3: namespace:package/interface - this is a direct path
                let interfaceName = try consumeIdentifier(message: "Expected interface name")
                var version: String? = nil
                if match(.at) {
                    version = try consumeIdentifier(message: "Expected version")
                } else if case .identifier(let v) = peek().kind, v.first?.isNumber == true {
                    advance()
                    version = v
                }
                try consume(.semicolon, message: "Expected ';' after import path")
                let path = WITUsePath.external(namespace: first, package: second, interface: interfaceName, version: version)
                return WITImport(path: path)
            } else {
                // Case 2: name: namespace:package/interface
                // first is the name, second is the namespace
                try consume(.colon, message: "Expected ':' in path")
                let packageName = try consumeIdentifier(message: "Expected package name")
                try consume(.slash, message: "Expected '/' after package name")
                let interfaceName = try consumeIdentifier(message: "Expected interface name")
                var version: String? = nil
                if match(.at) {
                    version = try consumeIdentifier(message: "Expected version")
                } else if case .identifier(let v) = peek().kind, v.first?.isNumber == true {
                    advance()
                    version = v
                }
                try consume(.semicolon, message: "Expected ';' after import path")
                let path = WITUsePath.external(namespace: second, package: packageName, interface: interfaceName, version: version)
                return WITImport(name: first, path: path)
            }
        }
        
        try consume(.semicolon, message: "Expected ';' after import")
        return WITImport(name: first)
    }
    
    private mutating func parseWorldExport() throws(WITParserError) -> WITExport {
        // Same logic as import
        let first = try consumeIdentifier(message: "Expected export name or namespace")
        
        if match(.colon) {
            if check(.interface) {
                let iface = try parseInterface()
                return WITExport(name: first, inline: iface)
            }
            
            let second = try consumeIdentifier(message: "Expected path or package name")
            
            if match(.slash) {
                // Direct path: namespace:package/interface
                let interfaceName = try consumeIdentifier(message: "Expected interface name")
                var version: String? = nil
                if match(.at) {
                    version = try consumeIdentifier(message: "Expected version")
                } else if case .identifier(let v) = peek().kind, v.first?.isNumber == true {
                    advance()
                    version = v
                }
                try consume(.semicolon, message: "Expected ';' after export path")
                let path = WITUsePath.external(namespace: first, package: second, interface: interfaceName, version: version)
                return WITExport(path: path)
            } else {
                // name: namespace:package/interface
                try consume(.colon, message: "Expected ':' in path")
                let packageName = try consumeIdentifier(message: "Expected package name")
                try consume(.slash, message: "Expected '/' after package name")
                let interfaceName = try consumeIdentifier(message: "Expected interface name")
                var version: String? = nil
                if match(.at) {
                    version = try consumeIdentifier(message: "Expected version")
                } else if case .identifier(let v) = peek().kind, v.first?.isNumber == true {
                    advance()
                    version = v
                }
                try consume(.semicolon, message: "Expected ';' after export path")
                let path = WITUsePath.external(namespace: second, package: packageName, interface: interfaceName, version: version)
                return WITExport(name: first, path: path)
            }
        }
        
        try consume(.semicolon, message: "Expected ';' after export")
        return WITExport(name: first)
    }
    
    private mutating func parseInclude() throws(WITParserError) -> WITInclude {
        try consume(.include, message: "Expected 'include'")
        let path = try parseUsePath()
        
        var withMap: [String: String] = [:]
        if match(.with) {
            try consume(.lBrace, message: "Expected '{' after 'with'")
            while !check(.rBrace) && !isAtEnd {
                let from = try consumeIdentifier(message: "Expected replacement name")
                try consume(.as, message: "Expected 'as'")
                let to = try consumeIdentifier(message: "Expected target name")
                withMap[from] = to
                if !check(.rBrace) {
                    try consume(.comma, message: "Expected ',' between replacements")
                }
            }
            try consume(.rBrace, message: "Expected '}' after with block")
        }
        
        try consume(.semicolon, message: "Expected ';' after include")
        
        return WITInclude(path: path, with: withMap)
    }
    
    // MARK: - Doc Comments
    
    private mutating func collectDocs() {
        while case .docComment(let doc) = peek().kind {
            pendingDocs.append(doc)
            advance()
        }
        
        // Skip annotations for now
        while case .annotation = peek().kind {
            advance()
        }
    }
    
    private mutating func consumePendingDocs() -> String? {
        guard !pendingDocs.isEmpty else { return nil }
        let docs = pendingDocs.joined(separator: "\n")
        pendingDocs = []
        return docs
    }
    
    // MARK: - Helpers
    
    private var isAtEnd: Bool {
        peek().kind == .eof
    }
    
    private func peek() -> WITToken {
        tokens[current]
    }
    
    private func check(_ kind: WITTokenKind) -> Bool {
        if isAtEnd { return false }
        return tokenKindMatches(peek().kind, kind)
    }
    
    private mutating func match(_ kind: WITTokenKind) -> Bool {
        if check(kind) {
            advance()
            return true
        }
        return false
    }
    
    @discardableResult
    private mutating func advance() -> WITToken {
        if !isAtEnd {
            current += 1
        }
        return tokens[current - 1]
    }
    
    private mutating func consume(_ kind: WITTokenKind, message: String) throws(WITParserError) {
        if check(kind) {
            advance()
            return
        }
        throw WITParserError.unexpectedToken(peek(), expected: message)
    }
    
    private mutating func consumeIdentifier(message: String) throws(WITParserError) -> String {
        if case .identifier(let name) = peek().kind {
            advance()
            return name
        }
        throw WITParserError.unexpectedToken(peek(), expected: message)
    }
    
    private func tokenKindMatches(_ a: WITTokenKind, _ b: WITTokenKind) -> Bool {
        switch (a, b) {
        case (.identifier, .identifier): return true
        case (.docComment, .docComment): return true
        case (.annotation, .annotation): return true
        default: return a == b
        }
    }
}

/// Parser errors
public enum WITParserError: Error, Sendable {
    case unexpectedToken(WITToken, expected: String)
    case unexpectedEndOfFile
}
