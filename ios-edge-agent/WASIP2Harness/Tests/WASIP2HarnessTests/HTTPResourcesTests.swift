import Testing
import Foundation
@testable import WASIP2Harness

/// Tests for HTTP resource types
@Suite("HTTPResources")
struct HTTPResourcesTests {
    
    // MARK: - HTTPFields Tests
    
    @Test("HTTPFields append adds entries")
    func testHTTPFieldsAppend() {
        let fields = HTTPFields()
        
        fields.append(name: "Content-Type", value: "application/json")
        fields.append(name: "Accept", value: "text/html")
        
        #expect(fields.entries.count == 2)
        #expect(fields.entries[0].0 == "Content-Type")
        #expect(fields.entries[0].1 == "application/json")
    }
    
    @Test("HTTPFields set replaces existing entries")
    func testHTTPFieldsSet() {
        let fields = HTTPFields()
        
        fields.append(name: "Content-Type", value: "text/plain")
        fields.set(name: "Content-Type", value: "application/json")
        
        #expect(fields.entries.count == 1)
        #expect(fields.entries[0].1 == "application/json")
    }
    
    // MARK: - HTTPIncomingRequest Tests
    
    @Test("HTTPIncomingRequest initializes with defaults")
    func testHTTPIncomingRequestInit() {
        let request = HTTPIncomingRequest()
        
        #expect(request.method == "GET")
        #expect(request.pathWithQuery == nil)
        #expect(request.body.isEmpty)
        #expect(request.bodyConsumed == false)
    }
    
    @Test("HTTPIncomingRequest initializes with custom values")
    func testHTTPIncomingRequestCustomInit() {
        let headers = HTTPFields()
        headers.append(name: "X-Custom", value: "value")
        
        let request = HTTPIncomingRequest(
            method: "POST",
            path: "/api/test?foo=bar",
            headers: headers,
            body: Data("test body".utf8)
        )
        
        #expect(request.method == "POST")
        #expect(request.pathWithQuery == "/api/test?foo=bar")
        #expect(request.body == Data("test body".utf8))
    }
    
    // MARK: - HTTPIncomingResponse Tests
    
    @Test("HTTPIncomingResponse readBody returns correct chunks")
    func testHTTPIncomingResponseReadBody() {
        let response = HTTPIncomingResponse(
            status: 200,
            headers: [("content-type", "text/plain")],
            body: Data("Hello, World!".utf8)
        )
        
        // Read first chunk
        let chunk1 = response.readBody(maxBytes: 5)
        #expect(chunk1 == Data("Hello".utf8))
        
        // Read second chunk
        let chunk2 = response.readBody(maxBytes: 5)
        #expect(chunk2 == Data(", Wor".utf8))
        
        // Read remaining
        let chunk3 = response.readBody(maxBytes: 100)
        #expect(chunk3 == Data("ld!".utf8))
    }
    
    @Test("HTTPIncomingResponse hasUnreadData tracks state")
    func testHTTPIncomingResponseHasUnreadData() {
        let response = HTTPIncomingResponse(
            status: 200,
            headers: [],
            body: Data("test".utf8)
        )
        
        #expect(response.hasUnreadData == true)
        
        _ = response.readBody(maxBytes: 100)
        
        #expect(response.hasUnreadData == false)
    }
    
    // MARK: - FutureIncomingResponse Tests
    
    @Test("FutureIncomingResponse signals ready")
    func testFutureIncomingResponseSignal() {
        let future = FutureIncomingResponse()
        
        // Simulate immediate signal completion
        future.response = HTTPIncomingResponse(status: 200, headers: [], body: Data())
        future.signalReady()
        
        // Wait for signal (should return immediately since already signaled)
        let result = future.waitForReady(timeout: 0.1)
        #expect(result == true)
        #expect(future.response != nil)
        #expect(future.response?.status == 200)
    }
    
    @Test("FutureIncomingResponse timeout returns false")
    func testFutureIncomingResponseTimeout() {
        let future = FutureIncomingResponse()
        
        // Don't signal - should timeout
        let result = future.waitForReady(timeout: 0.01)
        #expect(result == false)
    }
}
