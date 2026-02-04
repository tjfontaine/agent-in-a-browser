import Testing
import Foundation
@testable import MCPServerKit
@testable import WASIP2Harness

/// Tests for NativeMCPHost - the main MCP server host
@Suite("NativeMCPHost")
@MainActor
struct NativeMCPHostTests {
    
    @Test("Shared instance exists and is accessible")
    func testSharedInstanceExists() {
        let shared = NativeMCPHost.shared
        
        // Verify it's the expected type (singleton always exists)
        #expect(shared is NativeMCPHost)
    }
    
    @Test("Initial state is correct")
    func testInitialState() {
        // Create a fresh instance for testing (not the singleton)
        let host = NativeMCPHost()
        
        #expect(host.isReady == false)
        #expect(host.isLoading == false)
        #expect(host.port == 9293) // Default port
    }
    
    @Test("Filesystem is configurable")
    func testFilesystemConfiguration() {
        let host = NativeMCPHost()
        
        // Default filesystem should be the shared instance
        let defaultFS = host.filesystem
        #expect(defaultFS === SandboxFilesystem.shared)
        
        // Should be able to set a custom filesystem
        let customFS = SandboxFilesystem.shared
        host.filesystem = customFS
        #expect(host.filesystem === customFS)
    }
    
    @Test("Port is configurable")
    func testPortConfiguration() {
        let host = NativeMCPHost()
        
        #expect(host.port == 9293)
        
        host.port = 8080
        #expect(host.port == 8080)
    }
}

/// Tests for integration with WASIP2Harness types
@Suite("MCPServerKit Integration")
struct MCPServerKitIntegrationTests {
    
    @Test("ResourceRegistry is accessible from MCPServerKit")
    func testResourceRegistryAccessible() {
        // Verify we can create and use ResourceRegistry from WASIP2Harness
        let registry = ResourceRegistry()
        let obj = NSObject()
        let handle = registry.register(obj)
        
        #expect(handle > 0)
        
        let retrieved: NSObject? = registry.get(handle)
        #expect(retrieved === obj)
    }
    
    @Test("HTTPIncomingResponse is accessible from MCPServerKit")
    func testHTTPTypesAccessible() {
        // Verify HTTP types from WASIP2Harness are accessible
        let response = HTTPIncomingResponse(
            status: 200,
            headers: [("content-type", "text/plain")],
            body: Data("Hello from MCPServerKit tests".utf8)
        )
        
        #expect(response.status == 200)
        #expect(response.headers.count == 1)
    }
}
