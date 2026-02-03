// WasmBindgen SPM Build Tool Plugin
// Automatically generates Swift bindings from WIT files during build
//
// USAGE:
// 1. Build and install the wasmkit-bindgen tool:
//    cd WasmBindgen && swift build -c release
//    cp .build/release/wasmkit-bindgen /usr/local/bin/
//
// 2. Add WasmBindgen as a dependency to your package
// 3. Add the plugin to your target:
//    .target(name: "YourTarget", plugins: [.plugin(name: "WasmBindgenPlugin", package: "WasmBindgen")])
// 4. Create a WIT/ directory in your target with .wit files

import PackagePlugin
import Foundation

@main
struct WasmBindgenPlugin: BuildToolPlugin {
    func createBuildCommands(context: PluginContext, target: any Target) throws -> [Command] {
        guard let sourceTarget = target as? SourceModuleTarget else {
            return []
        }
        
        // Look for WIT directory in target
        let witDir = sourceTarget.directoryURL.appending(path: "WIT")
        
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: witDir.path, isDirectory: &isDir), isDir.boolValue else {
            return []
        }
        
        // Find all WIT files
        guard let enumerator = fm.enumerator(at: witDir, includingPropertiesForKeys: nil) else {
            return []
        }
        
        var witFiles: [URL] = []
        for case let fileURL as URL in enumerator {
            if fileURL.pathExtension == "wit" {
                witFiles.append(fileURL)
            }
        }
        
        if witFiles.isEmpty {
            return []
        }
        
        // Find wasmkit-bindgen in common locations
        let possiblePaths = [
            "/usr/local/bin/wasmkit-bindgen",
            "/opt/homebrew/bin/wasmkit-bindgen",
            context.package.directoryURL.appending(path: ".build/release/wasmkit-bindgen").path,
            context.package.directoryURL.appending(path: ".build/debug/wasmkit-bindgen").path,
        ]
        
        var bindgenPath: String? = nil
        for path in possiblePaths {
            if fm.fileExists(atPath: path) {
                bindgenPath = path
                break
            }
        }
        
        guard let toolPath = bindgenPath else {
            Diagnostics.error("wasmkit-bindgen not found. Build and install it first: cd WasmBindgen && swift build -c release")
            return []
        }
        
        // Output location
        let outputDir = context.pluginWorkDirectoryURL.appending(path: "Generated")
        let outputFile = outputDir.appending(path: "WASIBindings.swift")
        
        return [
            .buildCommand(
                displayName: "Generate WASI bindings from WIT (\(witFiles.count) files)",
                executable: URL(fileURLWithPath: toolPath),
                arguments: [
                    "--wit-dir", witDir.path,
                    "--output", outputDir.path,
                    "--with-providers",
                    "--async"
                ],
                inputFiles: witFiles,
                outputFiles: [outputFile]
            )
        ]
    }
}

#if canImport(XcodeProjectPlugin)
import XcodeProjectPlugin

extension WasmBindgenPlugin: XcodeBuildToolPlugin {
    func createBuildCommands(context: XcodePluginContext, target: XcodeTarget) throws -> [Command] {
        // Look for WIT directory in the project root
        let witDir = context.xcodeProject.directoryURL.appending(path: "WIT")
        
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: witDir.path, isDirectory: &isDir), isDir.boolValue else {
            return []
        }
        
        guard let enumerator = fm.enumerator(at: witDir, includingPropertiesForKeys: nil) else {
            return []
        }
        
        var witFiles: [URL] = []
        for case let fileURL as URL in enumerator {
            if fileURL.pathExtension == "wit" {
                witFiles.append(fileURL)
            }
        }
        
        if witFiles.isEmpty {
            return []
        }
        
        // Find wasmkit-bindgen - check package directory first, then system paths
        let packageDir = context.xcodeProject.directoryURL.appending(path: "../WasmBindgen")
        let possiblePaths = [
            packageDir.appending(path: ".build/release/wasmkit-bindgen").path,
            packageDir.appending(path: ".build/debug/wasmkit-bindgen").path,
            "/usr/local/bin/wasmkit-bindgen",
            "/opt/homebrew/bin/wasmkit-bindgen",
        ]
        
        var bindgenPath: String? = nil
        for path in possiblePaths {
            if fm.fileExists(atPath: path) {
                bindgenPath = path
                break
            }
        }
        
        guard let toolPath = bindgenPath else {
            Diagnostics.error("wasmkit-bindgen not found. Build it first: cd WasmBindgen && swift build")
            return []
        }
        
        let outputDir = context.pluginWorkDirectoryURL.appending(path: "Generated")
        let outputFile = outputDir.appending(path: "WASIBindings.swift")
        
        return [
            .buildCommand(
                displayName: "Generate WASI bindings from WIT (\(witFiles.count) files)",
                executable: URL(fileURLWithPath: toolPath),
                arguments: [
                    "--wit-dir", witDir.path,
                    "--output", outputDir.path,
                    "--with-providers",
                    "--async"
                ],
                inputFiles: witFiles,
                outputFiles: [outputFile]
            )
        ]
    }
}
#endif
