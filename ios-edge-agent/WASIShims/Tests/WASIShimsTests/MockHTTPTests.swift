import Testing
import Foundation
@testable import WASIShims
@testable import WASIP2Harness

/// Tests using MockHTTPRequestPerformer for HTTP provider testing
@Suite("MockHTTPTests")
struct MockHTTPTests {
    
    @Test("HttpOutgoingHandlerProvider accepts mock HTTP performer")
    func testHttpOutgoingHandlerWithMock() {
        let resources = ResourceRegistry()
        let mock = MockHTTPRequestPerformer()
        
        // This should compile and work - proves the protocol abstraction works
        let provider = HttpOutgoingHandlerProvider(resources: resources, httpManager: mock)
        
        #expect(provider.declaredImports.count > 0)
    }
    
    @Test("MockHTTPRequestPerformer captures requests correctly")
    func testMockCapturesRequests() {
        let mock = MockHTTPRequestPerformer()
        let future = FutureIncomingResponse()
        let resources = ResourceRegistry()
        
        mock.performRequest(
            method: "GET",
            url: "https://example.com/api",
            headers: [("Authorization", "Bearer token")],
            body: Data("request body".utf8),
            future: future,
            resources: resources
        )
        
        #expect(mock.lastRequest?.method == "GET")
        #expect(mock.lastRequest?.url == "https://example.com/api")
        #expect(mock.lastRequest?.headers.count == 1)
        #expect(mock.lastRequest?.body == Data("request body".utf8))
        #expect(mock.requestCount == 1)
    }
    
    @Test("MockHTTPRequestPerformer returns configured response")
    func testMockReturnsResponse() {
        let mock = MockHTTPRequestPerformer()
        mock.responseToReturn = HTTPIncomingResponse(
            status: 200,
            headers: [("content-type", "application/json")],
            body: Data("{\"success\":true}".utf8)
        )
        
        let future = FutureIncomingResponse()
        let resources = ResourceRegistry()
        
        mock.performRequest(
            method: "POST",
            url: "https://api.example.com/data",
            headers: [],
            body: nil,
            future: future,
            resources: resources
        )
        
        #expect(future.response != nil)
        #expect(future.response?.status == 200)
        #expect(future.response?.headers.first?.0 == "content-type")
    }
    
    @Test("MockHTTPRequestPerformer returns configured error")
    func testMockReturnsError() {
        let mock = MockHTTPRequestPerformer()
        mock.errorToReturn = "Connection refused"
        
        let future = FutureIncomingResponse()
        let resources = ResourceRegistry()
        
        mock.performRequest(
            method: "GET",
            url: "https://unreachable.example.com",
            headers: [],
            body: nil,
            future: future,
            resources: resources
        )
        
        #expect(future.error == "Connection refused")
        #expect(future.response == nil)
    }
    
    @Test("MockHTTPRequestPerformer tracks multiple requests")
    func testMockTracksMultipleRequests() {
        let mock = MockHTTPRequestPerformer()
        let resources = ResourceRegistry()
        
        for i in 1...5 {
            let future = FutureIncomingResponse()
            mock.performRequest(
                method: "GET",
                url: "https://example.com/\(i)",
                headers: [],
                body: nil,
                future: future,
                resources: resources
            )
        }
        
        #expect(mock.requestCount == 5)
        #expect(mock.lastRequest?.url == "https://example.com/5")
    }
}

/// Reusable mock for HTTP testing - mirrors the one in WASIP2Harness tests
/// This demonstrates how consuming packages can create their own mocks
class MockHTTPRequestPerformer: HTTPRequestPerforming, @unchecked Sendable {
    var lastRequest: (method: String, url: String, headers: [(String, String)], body: Data?)?
    var responseToReturn: HTTPIncomingResponse?
    var errorToReturn: String?
    var requestCount = 0
    
    func performRequest(
        method: String,
        url: String,
        headers: [(String, String)],
        body: Data?,
        future: FutureIncomingResponse,
        resources: ResourceRegistry
    ) {
        requestCount += 1
        lastRequest = (method, url, headers, body)
        
        if let error = errorToReturn {
            future.error = error
        } else if let response = responseToReturn {
            future.response = response
        }
        
        future.signalReady()
    }
}
