// WIT Abstract Syntax Tree
// Represents parsed WIT interface definitions

/// A complete WIT document (one .wit file)
public struct WITDocument: Sendable, Equatable {
    /// Package declaration: `package mcp:module-loader@0.1.0;`
    public var package: WITPackage?
    
    /// Top-level items (interfaces, worlds, type definitions)
    public var items: [WITItem]
    
    public init(package: WITPackage? = nil, items: [WITItem] = []) {
        self.package = package
        self.items = items
    }
}

/// Package identifier: `namespace:name@version`
public struct WITPackage: Sendable, Equatable {
    public var namespace: String
    public var name: String
    public var version: String?
    
    public init(namespace: String, name: String, version: String? = nil) {
        self.namespace = namespace
        self.name = name
        self.version = version
    }
    
    /// Full identifier like "wasi:io@0.2.9"
    public var fullName: String {
        var result = "\(namespace):\(name)"
        if let version = version {
            result += "@\(version)"
        }
        return result
    }
}

/// Top-level WIT items
public enum WITItem: Sendable, Equatable {
    case interface(WITInterface)
    case world(WITWorld)
    case typeAlias(WITTypeAlias)
    case use(WITUse)
}

/// Interface definition: `interface streams { ... }`
public struct WITInterface: Sendable, Equatable {
    public var name: String
    public var items: [WITInterfaceItem]
    public var docs: String?
    
    public init(name: String, items: [WITInterfaceItem] = [], docs: String? = nil) {
        self.name = name
        self.items = items
        self.docs = docs
    }
}

/// World definition: `world my-world { ... }`
public struct WITWorld: Sendable, Equatable {
    public var name: String
    public var items: [WITWorldItem]
    public var docs: String?
    
    public init(name: String, items: [WITWorldItem] = [], docs: String? = nil) {
        self.name = name
        self.items = items
        self.docs = docs
    }
}

/// Items within an interface
public enum WITInterfaceItem: Sendable, Equatable {
    case function(WITFunction)
    case resource(WITResource)
    case record(WITRecord)
    case variant(WITVariant)
    case enumType(WITEnum)
    case flags(WITFlags)
    case typeAlias(WITTypeAlias)
    case use(WITUse)
}

/// Items within a world
public enum WITWorldItem: Sendable, Equatable {
    case `import`(WITImport)
    case export(WITExport)
    case include(WITInclude)
    case typeAlias(WITTypeAlias)
    case use(WITUse)
}

/// Function definition
public struct WITFunction: Sendable, Equatable {
    public var name: String
    public var params: [WITParam]
    public var results: WITResults?
    public var docs: String?
    
    public init(name: String, params: [WITParam] = [], results: WITResults? = nil, docs: String? = nil) {
        self.name = name
        self.params = params
        self.results = results
        self.docs = docs
    }
}

/// Function parameter
public struct WITParam: Sendable, Equatable {
    public var name: String
    public var type: WITType
    
    public init(name: String, type: WITType) {
        self.name = name
        self.type = type
    }
}

/// Function results (single type, named results, or void)
public enum WITResults: Sendable, Equatable {
    case single(WITType)
    case named([WITParam])
}

/// Resource definition with methods
public struct WITResource: Sendable, Equatable {
    public var name: String
    public var methods: [WITResourceMethod]
    public var docs: String?
    
    public init(name: String, methods: [WITResourceMethod] = [], docs: String? = nil) {
        self.name = name
        self.methods = methods
        self.docs = docs
    }
}

/// Resource method
public struct WITResourceMethod: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case `static`
        case instance
        case constructor
    }
    
    public var kind: Kind
    public var name: String
    public var params: [WITParam]
    public var results: WITResults?
    public var docs: String?
    
    public init(kind: Kind, name: String, params: [WITParam] = [], results: WITResults? = nil, docs: String? = nil) {
        self.kind = kind
        self.name = name
        self.params = params
        self.results = results
        self.docs = docs
    }
}

/// Record (struct) definition
public struct WITRecord: Sendable, Equatable {
    public var name: String
    public var fields: [WITField]
    public var docs: String?
    
    public init(name: String, fields: [WITField] = [], docs: String? = nil) {
        self.name = name
        self.fields = fields
        self.docs = docs
    }
}

/// Record field
public struct WITField: Sendable, Equatable {
    public var name: String
    public var type: WITType
    
    public init(name: String, type: WITType) {
        self.name = name
        self.type = type
    }
}

/// Variant (tagged union) definition
public struct WITVariant: Sendable, Equatable {
    public var name: String
    public var cases: [WITCase]
    public var docs: String?
    
    public init(name: String, cases: [WITCase] = [], docs: String? = nil) {
        self.name = name
        self.cases = cases
        self.docs = docs
    }
}

/// Variant case
public struct WITCase: Sendable, Equatable {
    public var name: String
    public var type: WITType?
    
    public init(name: String, type: WITType? = nil) {
        self.name = name
        self.type = type
    }
}

/// Enum definition
public struct WITEnum: Sendable, Equatable {
    public var name: String
    public var cases: [String]
    public var docs: String?
    
    public init(name: String, cases: [String] = [], docs: String? = nil) {
        self.name = name
        self.cases = cases
        self.docs = docs
    }
}

/// Flags definition
public struct WITFlags: Sendable, Equatable {
    public var name: String
    public var flags: [String]
    public var docs: String?
    
    public init(name: String, flags: [String] = [], docs: String? = nil) {
        self.name = name
        self.flags = flags
        self.docs = docs
    }
}

/// Type alias
public struct WITTypeAlias: Sendable, Equatable {
    public var name: String
    public var type: WITType
    
    public init(name: String, type: WITType) {
        self.name = name
        self.type = type
    }
}

/// Use statement: `use wasi:io/poll@0.2.9.{pollable};`
public struct WITUse: Sendable, Equatable {
    public var path: WITUsePath
    public var names: [WITUseItem]
    
    public init(path: WITUsePath, names: [WITUseItem] = []) {
        self.path = path
        self.names = names
    }
}

/// Use path: `wasi:io/poll@0.2.9` or `error`
public enum WITUsePath: Sendable, Equatable {
    case local(String)  // Reference within same package
    case external(namespace: String, package: String, interface: String, version: String?)
}

/// Item in a use statement (with optional rename)
public struct WITUseItem: Sendable, Equatable {
    public var name: String
    public var `as`: String?
    
    public init(name: String, as asName: String? = nil) {
        self.name = name
        self.as = asName
    }
}

/// Import in a world
public struct WITImport: Sendable, Equatable {
    public var name: String?
    public var path: WITUsePath?
    public var inline: WITInterface?
    
    public init(name: String? = nil, path: WITUsePath? = nil, inline: WITInterface? = nil) {
        self.name = name
        self.path = path
        self.inline = inline
    }
}

/// Export in a world
public struct WITExport: Sendable, Equatable {
    public var name: String?
    public var path: WITUsePath?
    public var inline: WITInterface?
    
    public init(name: String? = nil, path: WITUsePath? = nil, inline: WITInterface? = nil) {
        self.name = name
        self.path = path
        self.inline = inline
    }
}

/// Include in a world
public struct WITInclude: Sendable, Equatable {
    public var path: WITUsePath
    public var with: [String: String]
    
    public init(path: WITUsePath, with: [String: String] = [:]) {
        self.path = path
        self.with = with
    }
}

/// WIT type expressions
public indirect enum WITType: Sendable, Equatable {
    // Primitives
    case bool
    case u8, u16, u32, u64
    case s8, s16, s32, s64
    case f32, f64
    case char
    case string
    
    // Built-in generic types
    case list(WITType)
    case option(WITType)
    case result(ok: WITType?, err: WITType?)
    case tuple([WITType])
    
    // Handle types
    case own(String)
    case borrow(String)
    
    // Named type reference
    case named(String)
}
