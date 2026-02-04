import Testing
import Foundation
@testable import WASIShims
@testable import WASIP2Harness

/// Tests for provider registration and declared imports
@Suite("ProviderRegistration")
struct ProviderRegistrationTests {
    
    // MARK: - Module Name Tests
    
    @Test("ClocksProvider has correct module name")
    func testClocksProviderModuleName() {
        #expect(ClocksProvider.moduleName == "wasi:clocks")
    }
    
    @Test("CliProvider has correct module name")
    func testCliProviderModuleName() {
        #expect(CliProvider.moduleName == "wasi:cli")
    }
    
    @Test("RandomProvider has correct module name")
    func testRandomProviderModuleName() {
        #expect(RandomProvider.moduleName == "wasi:random")
    }
    
    @Test("HttpTypesProvider has correct module name")
    func testHttpTypesProviderModuleName() {
        #expect(HttpTypesProvider.moduleName.hasPrefix("wasi:http/types"))
    }
    
    @Test("HttpOutgoingHandlerProvider has correct module name")
    func testHttpOutgoingHandlerProviderModuleName() {
        #expect(HttpOutgoingHandlerProvider.moduleName == "wasi:http/outgoing-handler")
    }
    
    @Test("IoErrorProvider has correct module name")
    func testIoErrorProviderModuleName() {
        #expect(IoErrorProvider.moduleName == "wasi:io/error")
    }
    
    @Test("IoPollProvider has correct module name")
    func testIoPollProviderModuleName() {
        #expect(IoPollProvider.moduleName == "wasi:io/poll")
    }
    
    @Test("IoStreamsProvider has correct module name")
    func testIoStreamsProviderModuleName() {
        #expect(IoStreamsProvider.moduleName == "wasi:io/streams")
    }
    
    // MARK: - Declared Imports Tests
    
    @Test("ClocksProvider declares expected imports")
    func testClocksProviderDeclaredImports() {
        let resources = ResourceRegistry()
        let provider = ClocksProvider(resources: resources)
        let imports = provider.declaredImports
        
        #expect(imports.count > 0)
        
        // Verify at least one expected import exists
        let hasMonotonic = imports.contains { 
            $0.module.contains("wasi:clocks/monotonic-clock")
        }
        #expect(hasMonotonic == true)
    }
    
    @Test("IoStreamsProvider declares expected imports")
    func testIoStreamsProviderDeclaredImports() {
        let resources = ResourceRegistry()
        let provider = IoStreamsProvider(resources: resources)
        let imports = provider.declaredImports
        
        #expect(imports.count > 0)
        
        // Verify expected method imports
        let hasInputStreamRead = imports.contains {
            $0.name.contains("input-stream.read")
        }
        #expect(hasInputStreamRead == true)
    }
    
    @Test("HttpOutgoingHandlerProvider declares handle import")
    func testHttpOutgoingHandlerProviderDeclaredImports() {
        let resources = ResourceRegistry()
        let httpManager = HTTPRequestManager()
        let provider = HttpOutgoingHandlerProvider(resources: resources, httpManager: httpManager)
        let imports = provider.declaredImports
        
        #expect(imports.count > 0)
        
        // Verify the handle import exists
        let hasHandle = imports.contains { $0.name == "handle" }
        #expect(hasHandle == true)
    }
    
    // MARK: - Provider Initialization Tests
    
    @Test("Providers initialize with shared resources")
    func testProvidersShareResources() {
        let resources = ResourceRegistry()
        
        // Register a test resource
        let testObj = NSObject()
        let handle = resources.register(testObj)
        
        // Create multiple providers with same registry
        let clocksProvider = ClocksProvider(resources: resources)
        let ioProvider = IoStreamsProvider(resources: resources)
        
        // Both should see the same resources (verified by declaredImports not crashing)
        #expect(clocksProvider.declaredImports.count > 0)
        #expect(ioProvider.declaredImports.count > 0)
        
        // Resource should still be accessible
        let retrieved: NSObject? = resources.get(handle)
        #expect(retrieved === testObj)
    }
}
