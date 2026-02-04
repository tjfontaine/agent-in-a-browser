import Testing
import Foundation
@testable import WASIP2Harness

/// Tests for WASI stream resources
@Suite("StreamResources")
struct StreamResourcesTests {
    
    // MARK: - WASIInputStream Tests
    
    @Test("WASIInputStream reads data correctly")
    func testWASIInputStreamRead() {
        let response = HTTPIncomingResponse(
            status: 200,
            headers: [],
            body: Data("Hello, World!".utf8)
        )
        let body = HTTPIncomingBody(response: response)
        let stream = WASIInputStream(body: body)
        
        let data = stream.read(maxBytes: 5)
        #expect(data == Data("Hello".utf8))
    }
    
    @Test("WASIInputStream EOF detection")
    func testWASIInputStreamEOF() {
        let response = HTTPIncomingResponse(
            status: 200,
            headers: [],
            body: Data("test".utf8)
        )
        response.streamComplete = true
        let body = HTTPIncomingBody(response: response)
        let stream = WASIInputStream(body: body)
        
        #expect(stream.isEOF == false) // Has data to read
        
        // Read all data
        _ = stream.read(maxBytes: 100)
        
        #expect(stream.isEOF == true) // Now at EOF
    }
    
    @Test("WASIInputStream blocking read")
    func testWASIInputStreamBlockingRead() {
        let response = HTTPIncomingResponse(
            status: 200,
            headers: [],
            body: Data("blocking test".utf8)
        )
        let body = HTTPIncomingBody(response: response)
        let stream = WASIInputStream(body: body)
        
        let data = stream.blockingRead(maxBytes: 8)
        #expect(data == Data("blocking".utf8))
    }
    
    // MARK: - WASIOutputStream Tests
    
    @Test("WASIOutputStream writes data")
    func testWASIOutputStreamWrite() {
        let body = HTTPOutgoingBody()
        let stream = WASIOutputStream(body: body)
        
        stream.write(Data("Hello".utf8))
        stream.write(Data(" World".utf8))
        
        #expect(body.data == Data("Hello World".utf8))
    }
    
    // MARK: - ProcessInputStream Tests
    
    @Test("ProcessInputStream reads and tracks EOF")
    func testProcessInputStreamRead() {
        let stream = ProcessInputStream(data: [0x48, 0x65, 0x6c, 0x6c, 0x6f]) // "Hello"
        
        let (data1, eof1) = stream.read(maxBytes: 3)
        #expect(data1 == [0x48, 0x65, 0x6c]) // "Hel"
        #expect(eof1 == false)
        
        let (data2, eof2) = stream.read(maxBytes: 10)
        #expect(data2 == [0x6c, 0x6f]) // "lo"
        #expect(eof2 == true)
    }
    
    @Test("ProcessInputStream empty read at EOF")
    func testProcessInputStreamEmptyRead() {
        let stream = ProcessInputStream(data: [0x41]) // "A"
        
        _ = stream.read(maxBytes: 10) // Read everything
        
        let (data, eof) = stream.read(maxBytes: 10)
        #expect(data.isEmpty)
        #expect(eof == true)
    }
    
    // MARK: - ProcessOutputStream Tests
    
    @Test("ProcessOutputStream writes via handler")
    func testProcessOutputStreamWrite() {
        var receivedData: [[UInt8]] = []
        
        let stream = ProcessOutputStream { data in
            receivedData.append(data)
        }
        
        stream.write([0x48, 0x69]) // "Hi"
        stream.write([0x21]) // "!"
        
        #expect(receivedData.count == 2)
        #expect(receivedData[0] == [0x48, 0x69])
        #expect(receivedData[1] == [0x21])
    }
}
