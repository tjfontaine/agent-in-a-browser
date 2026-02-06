import XCTest
@testable import EdgeAgent

final class FoundationModelsServerTests: XCTestCase {
    
    // MARK: - Request Parsing Tests
    
    func testChatCompletionRequestDecoding() throws {
        let json = """
        {
            "model": "apple-on-device",
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": "Hello, how are you?"}
            ],
            "temperature": 0.7,
            "max_tokens": 100,
            "stream": false
        }
        """
        
        let data = json.data(using: .utf8)!
        let request = try JSONDecoder().decode(ChatCompletionRequest.self, from: data)
        
        XCTAssertEqual(request.model, "apple-on-device")
        XCTAssertEqual(request.messages.count, 2)
        XCTAssertEqual(request.messages[0].role, "system")
        XCTAssertEqual(request.messages[1].role, "user")
        XCTAssertEqual(request.messages[1].content, "Hello, how are you?")
        XCTAssertEqual(request.temperature, 0.7)
        XCTAssertEqual(request.maxTokens, 100)
        XCTAssertEqual(request.stream, false)
    }
    
    func testChatCompletionRequestWithStreamingEnabled() throws {
        let json = """
        {
            "model": "apple-on-device",
            "messages": [{"role": "user", "content": "Hi"}],
            "stream": true
        }
        """
        
        let data = json.data(using: .utf8)!
        let request = try JSONDecoder().decode(ChatCompletionRequest.self, from: data)
        
        XCTAssertEqual(request.stream, true)
        XCTAssertNil(request.temperature)
        XCTAssertNil(request.maxTokens)
    }
    
    func testChatCompletionRequestMinimalFields() throws {
        let json = """
        {
            "model": "apple-on-device",
            "messages": [{"role": "user", "content": "Hello"}]
        }
        """
        
        let data = json.data(using: .utf8)!
        let request = try JSONDecoder().decode(ChatCompletionRequest.self, from: data)
        
        XCTAssertEqual(request.model, "apple-on-device")
        XCTAssertEqual(request.messages.count, 1)
        XCTAssertNil(request.stream)
    }
    
    // MARK: - Response Encoding Tests
    
    func testChatCompletionResponseEncoding() throws {
        let response = ChatCompletionResponse(
            id: "chatcmpl-123",
            object: "chat.completion",
            created: 1699000000,
            model: "apple-on-device",
            choices: [
                ChatChoice(
                    index: 0,
                    message: ChatMessage(role: "assistant", content: "Hello! I'm doing well."),
                    finishReason: "stop"
                )
            ],
            usage: ChatUsage(
                promptTokens: 10,
                completionTokens: 20,
                totalTokens: 30
            )
        )
        
        let data = try JSONEncoder().encode(response)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        
        XCTAssertEqual(json["id"] as? String, "chatcmpl-123")
        XCTAssertEqual(json["object"] as? String, "chat.completion")
        XCTAssertEqual(json["model"] as? String, "apple-on-device")
        
        let choices = json["choices"] as! [[String: Any]]
        XCTAssertEqual(choices.count, 1)
        XCTAssertEqual(choices[0]["finish_reason"] as? String, "stop")
        
        let usage = json["usage"] as! [String: Any]
        XCTAssertEqual(usage["total_tokens"] as? Int, 30)
    }
    
    // MARK: - Streaming Chunk Tests
    
    func testStreamingChunkEncoding() throws {
        let chunk = ChatCompletionChunk(
            id: "chatcmpl-456",
            object: "chat.completion.chunk",
            created: 1699000000,
            model: "apple-on-device",
            choices: [
                StreamChoice(
                    index: 0,
                    delta: StreamDelta(role: nil, content: "Hello"),
                    finishReason: nil
                )
            ]
        )
        
        let data = try JSONEncoder().encode(chunk)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        
        XCTAssertEqual(json["object"] as? String, "chat.completion.chunk")
        
        let choices = json["choices"] as! [[String: Any]]
        let delta = choices[0]["delta"] as! [String: Any]
        XCTAssertEqual(delta["content"] as? String, "Hello")
    }
    
    func testStreamingFinalChunk() throws {
        let chunk = ChatCompletionChunk(
            id: "chatcmpl-456",
            object: "chat.completion.chunk",
            created: 1699000000,
            model: "apple-on-device",
            choices: [
                StreamChoice(
                    index: 0,
                    delta: StreamDelta(role: nil, content: nil),
                    finishReason: "stop"
                )
            ]
        )
        
        let data = try JSONEncoder().encode(chunk)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        
        let choices = json["choices"] as! [[String: Any]]
        XCTAssertEqual(choices[0]["finish_reason"] as? String, "stop")
    }
    
    // MARK: - Models Response Tests
    
    func testModelsResponseEncoding() throws {
        let response = ModelsResponse(
            object: "list",
            data: [
                ModelInfo(
                    id: "apple-on-device",
                    object: "model",
                    created: 1699000000,
                    ownedBy: "apple"
                )
            ]
        )
        
        let data = try JSONEncoder().encode(response)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        
        XCTAssertEqual(json["object"] as? String, "list")
        
        let models = json["data"] as! [[String: Any]]
        XCTAssertEqual(models.count, 1)
        XCTAssertEqual(models[0]["id"] as? String, "apple-on-device")
        XCTAssertEqual(models[0]["owned_by"] as? String, "apple")
    }
}
