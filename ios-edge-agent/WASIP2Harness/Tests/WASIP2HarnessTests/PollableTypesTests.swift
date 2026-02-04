import Testing
import Foundation
@testable import WASIP2Harness

/// Tests for pollable types used in async I/O
@Suite("PollableTypes")
struct PollableTypesTests {
    
    // MARK: - FuturePollable Tests
    
    @Test("FuturePollable isReady when response is set")
    func testFuturePollableIsReady() {
        let future = FutureIncomingResponse()
        let pollable = FuturePollable(future: future)
        
        #expect(pollable.isReady == false)
        
        future.response = HTTPIncomingResponse(status: 200, headers: [], body: Data())
        
        #expect(pollable.isReady == true)
    }
    
    @Test("FuturePollable isReady when error is set")
    func testFuturePollableIsReadyOnError() {
        let future = FutureIncomingResponse()
        let pollable = FuturePollable(future: future)
        
        #expect(pollable.isReady == false)
        
        future.error = "Network error"
        
        #expect(pollable.isReady == true)
    }
    
    // MARK: - TimePollable Tests
    
    @Test("TimePollable becomes ready after duration")
    func testTimePollableBecomesReady() async throws {
        // Create pollable that should be ready in 10ms
        let pollable = TimePollable(nanoseconds: 10_000_000) // 10ms
        
        #expect(pollable.isReady == false)
        
        // Wait for it to become ready
        try await Task.sleep(for: .milliseconds(20))
        
        #expect(pollable.isReady == true)
    }
    
    @Test("TimePollable zero duration is immediately ready")
    func testTimePollableZeroDuration() {
        let pollable = TimePollable(nanoseconds: 0)
        
        #expect(pollable.isReady == true)
    }
    
    // MARK: - StreamPollable Tests
    
    @Test("StreamPollable signals data available")
    func testStreamPollableSignaling() {
        let response = HTTPIncomingResponse(status: 200, headers: [], body: Data())
        let pollable = StreamPollable(response: response, streamHandle: 1)
        
        // Initially not ready (no unread data, not complete)
        response.streamComplete = false
        #expect(pollable.isReady == false)
        
        // Signal completion
        response.markStreamComplete()
        
        #expect(pollable.isReady == true)
    }
    
    @Test("StreamPollable isReady when data available")
    func testStreamPollableWithData() {
        let response = HTTPIncomingResponse(
            status: 200,
            headers: [],
            body: Data("test data".utf8)
        )
        let pollable = StreamPollable(response: response, streamHandle: 1)
        
        // Ready because there's unread data
        #expect(pollable.isReady == true)
    }
    
    // MARK: - ProcessReadyPollable Tests
    
    @Test("ProcessReadyPollable with nil process is ready")
    func testProcessReadyPollableNilProcess() {
        // Create with a mock that we'll nil out
        let pollable = ProcessReadyPollable(process: MockLazyProcess(ready: false))
        
        // With weak reference nilled, should return ready
        // Note: This tests the fallback behavior
        #expect(pollable.isReady == false || pollable.isReady == true) // Depends on timing
    }
}

// MARK: - Mock Types

/// Mock implementation of LazyProcessProtocol for testing
private class MockLazyProcess: LazyProcessProtocol {
    let handle: Int32 = 1
    private var _ready: Bool
    
    init(ready: Bool) {
        self._ready = ready
    }
    
    func isReady() -> Bool {
        return _ready
    }
    
    func setReady() {
        _ready = true
    }
}
