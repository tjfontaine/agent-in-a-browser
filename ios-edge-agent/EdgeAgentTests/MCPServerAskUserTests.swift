import XCTest
@testable import EdgeAgent

@MainActor
final class MCPServerAskUserTests: XCTestCase {
    func testResolveAskUserSignalsSemaphore() throws {
        let server = MCPServer.shared
        let requestId = "test-\(UUID().uuidString)"
        let semaphore = DispatchSemaphore(value: 0)
        
        // Simulate what handleJSONRPCMethodSync does: store semaphore
        server.askUserLock.lock()
        server.askUserSemaphores[requestId] = semaphore
        server.askUserLock.unlock()
        
        // Resolve from MainActor (simulates user tap)
        server.resolveAskUser(requestId: requestId, response: "approved")
        
        // Semaphore should already be signaled
        let result = semaphore.wait(timeout: .now() + 1.0)
        XCTAssertEqual(result, .success, "Semaphore should have been signaled")
        
        // Response should be stored
        server.askUserLock.lock()
        let response = server.askUserResponses.removeValue(forKey: requestId)
        server.askUserLock.unlock()
        XCTAssertEqual(response, "approved")
    }
    
    func testResolveAskUserWithContinuation() async throws {
        let server = MCPServer.shared
        let requestId = "test-\(UUID().uuidString)"
        
        // Test the MCPServerKit (async) path still works
        let task = Task<String, Never> {
            await withCheckedContinuation { continuation in
                server.askUserLock.lock()
                server.askUserContinuations[requestId] = continuation
                server.askUserLock.unlock()
            }
        }
        
        // Give the continuation time to register
        try await Task.sleep(nanoseconds: 50_000_000)
        
        server.resolveAskUser(requestId: requestId, response: "confirmed")
        let result = await task.value
        XCTAssertEqual(result, "confirmed")
    }
}
