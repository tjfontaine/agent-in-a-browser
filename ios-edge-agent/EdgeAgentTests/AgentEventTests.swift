import XCTest
@testable import EdgeAgent

final class AgentEventTests: XCTestCase {
    
    func testParseStreamStart() throws {
        let dict: [String: Any] = ["type": "stream_start"]
        let event = AgentEvent.from(dict)
        
        if case .streamStart = event {
            // Success
        } else {
            XCTFail("Expected streamStart, got \(String(describing: event))")
        }
    }
    
    func testParseStreamChunk() throws {
        let dict: [String: Any] = ["type": "stream_chunk", "text": "Hello world"]
        let event = AgentEvent.from(dict)
        
        if case .chunk(let text) = event {
            XCTAssertEqual(text, "Hello world")
        } else {
            XCTFail("Expected chunk, got \(String(describing: event))")
        }
    }
    
    func testParseStreamComplete() throws {
        let dict: [String: Any] = ["type": "stream_complete", "text": "Final response"]
        let event = AgentEvent.from(dict)
        
        if case .complete(let text) = event {
            XCTAssertEqual(text, "Final response")
        } else {
            XCTFail("Expected complete, got \(String(describing: event))")
        }
    }
    
    func testParseStreamError() throws {
        let dict: [String: Any] = ["type": "stream_error", "error": "API rate limit"]
        let event = AgentEvent.from(dict)
        
        if case .error(let msg) = event {
            XCTAssertEqual(msg, "API rate limit")
        } else {
            XCTFail("Expected error, got \(String(describing: event))")
        }
    }
    
    func testParseToolCall() throws {
        let dict: [String: Any] = ["type": "tool_call", "name": "read_file"]
        let event = AgentEvent.from(dict)
        
        if case .toolCall(let name) = event {
            XCTAssertEqual(name, "read_file")
        } else {
            XCTFail("Expected toolCall, got \(String(describing: event))")
        }
    }
    
    func testParseToolResult() throws {
        let dict: [String: Any] = [
            "type": "tool_result",
            "name": "list_files",
            "output": "file1.txt\nfile2.txt",
            "is_error": false
        ]
        let event = AgentEvent.from(dict)
        
        if case .toolResult(let name, let output, let isError) = event {
            XCTAssertEqual(name, "list_files")
            XCTAssertEqual(output, "file1.txt\nfile2.txt")
            XCTAssertFalse(isError)
        } else {
            XCTFail("Expected toolResult, got \(String(describing: event))")
        }
    }
    
    func testParseToolResultWithError() throws {
        let dict: [String: Any] = [
            "type": "tool_result",
            "name": "run_command",
            "output": "Command failed: exit code 1",
            "is_error": true
        ]
        let event = AgentEvent.from(dict)
        
        if case .toolResult(_, _, let isError) = event {
            XCTAssertTrue(isError)
        } else {
            XCTFail("Expected toolResult, got \(String(describing: event))")
        }
    }
    
    func testParseTaskStart() throws {
        let dict: [String: Any] = [
            "type": "task_start",
            "id": "task-123",
            "name": "Build App",
            "description": "Building the application"
        ]
        let event = AgentEvent.from(dict)
        
        if case .taskStart(let id, let name, let desc) = event {
            XCTAssertEqual(id, "task-123")
            XCTAssertEqual(name, "Build App")
            XCTAssertEqual(desc, "Building the application")
        } else {
            XCTFail("Expected taskStart, got \(String(describing: event))")
        }
    }
    
    func testParseTaskUpdate() throws {
        let dict: [String: Any] = [
            "type": "task_update",
            "id": "task-123",
            "status": "Running tests",
            "progress": NSNumber(value: 75)
        ]
        let event = AgentEvent.from(dict)
        
        if case .taskUpdate(let id, let status, let progress) = event {
            XCTAssertEqual(id, "task-123")
            XCTAssertEqual(status, "Running tests")
            XCTAssertEqual(progress, 75)
        } else {
            XCTFail("Expected taskUpdate, got \(String(describing: event))")
        }
    }
    
    func testParseTaskComplete() throws {
        let dict: [String: Any] = [
            "type": "task_complete",
            "id": "task-123",
            "success": true,
            "output": "All tests passed"
        ]
        let event = AgentEvent.from(dict)
        
        if case .taskComplete(let id, let success, let output) = event {
            XCTAssertEqual(id, "task-123")
            XCTAssertTrue(success)
            XCTAssertEqual(output, "All tests passed")
        } else {
            XCTFail("Expected taskComplete, got \(String(describing: event))")
        }
    }
    
    func testParseModelLoading() throws {
        let dict: [String: Any] = [
            "type": "model_loading",
            "text": "Downloading weights...",
            "progress": NSNumber(value: 0.45)
        ]
        let event = AgentEvent.from(dict)
        
        if case .modelLoading(let text, let progress) = event {
            XCTAssertEqual(text, "Downloading weights...")
            XCTAssertEqual(progress, 0.45, accuracy: 0.001)
        } else {
            XCTFail("Expected modelLoading, got \(String(describing: event))")
        }
    }
    
    func testParseReady() throws {
        let dict: [String: Any] = ["type": "ready"]
        let event = AgentEvent.from(dict)
        
        if case .ready = event {
            // Success
        } else {
            XCTFail("Expected ready, got \(String(describing: event))")
        }
    }
    
    func testParseUnknownTypeReturnsNil() throws {
        let dict: [String: Any] = ["type": "unknown_event"]
        let event = AgentEvent.from(dict)
        
        XCTAssertNil(event)
    }
    
    func testParseMissingTypeReturnsNil() throws {
        let dict: [String: Any] = ["text": "some text"]
        let event = AgentEvent.from(dict)
        
        XCTAssertNil(event)
    }
    
    func testEventIdUniqueness() throws {
        let event1 = AgentEvent.chunk("Hello")
        let event2 = AgentEvent.chunk("World")
        
        XCTAssertNotEqual(event1.id, event2.id)
    }
}
