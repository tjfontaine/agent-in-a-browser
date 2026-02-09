// swift-tools-version: 6.2

import PackageDescription
import CompilerPluginSupport

let package = Package(
    name: "WasmBindgen",
    platforms: [
        .macOS(.v26),
        .iOS(.v26)
    ],
    products: [
        // Library for WIT parsing and Swift code generation
        .library(name: "WITParser", targets: ["WITParser"]),
        .library(name: "SwiftBindgenCore", targets: ["SwiftBindgenCore"]),
        
        // Runtime library with macros for type-safe WASI registration
        .library(name: "WasmBindgenRuntime", targets: ["WasmBindgenRuntime"]),
        
        // Executable for CLI usage
        .executable(name: "wasmkit-bindgen", targets: ["WasmBindgenCLI"]),
        
        // Build plugin for Xcode integration
        .plugin(name: "WasmBindgenPlugin", targets: ["WasmBindgenPlugin"]),
    ],
    dependencies: [
        // ArgumentParser for CLI
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.3.0"),
        // Swift Syntax for macros (602.x matches Swift 6.2)
        .package(url: "https://github.com/swiftlang/swift-syntax", from: "602.0.0"),
    ],
    targets: [
        // MARK: - WIT Parser
        
        /// Pure WIT lexer and parser - no dependencies
        .target(
            name: "WITParser",
            dependencies: [],
            path: "Sources/WITParser"
        ),
        
        // MARK: - Code Generator
        
        /// Generates Swift protocols and registrations from parsed WIT
        .target(
            name: "SwiftBindgenCore",
            dependencies: ["WITParser"],
            path: "Sources/SwiftBindgenCore"
        ),
        
        // MARK: - Runtime Library
        
        /// Runtime support with macros for type-safe WASI imports
        .target(
            name: "WasmBindgenRuntime",
            dependencies: ["WasmBindgenMacros"],
            path: "Sources/WasmBindgenRuntime"
        ),
        
        // MARK: - Macros
        
        /// Swift macro implementations for type-safe registration
        .macro(
            name: "WasmBindgenMacros",
            dependencies: [
                .product(name: "SwiftSyntax", package: "swift-syntax"),
                .product(name: "SwiftSyntaxMacros", package: "swift-syntax"),
                .product(name: "SwiftCompilerPlugin", package: "swift-syntax"),
            ],
            path: "Sources/WasmBindgenMacros"
        ),
        
        // MARK: - CLI Tool
        
        /// Command-line tool for generating bindings
        .executableTarget(
            name: "WasmBindgenCLI",
            dependencies: [
                "WITParser",
                "SwiftBindgenCore",
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
            ],
            path: "Sources/WasmBindgenCLI"
        ),
        
        // MARK: - Build Plugin
        
        /// SPM Build Tool Plugin for automatic generation
        .plugin(
            name: "WasmBindgenPlugin",
            capability: .buildTool(),
            path: "Plugins/WasmBindgenPlugin"
        ),
        
        // MARK: - Tests
        
        .testTarget(
            name: "WITParserTests",
            dependencies: ["WITParser"],
            path: "Tests/WITParserTests"
        ),
    ]
)
