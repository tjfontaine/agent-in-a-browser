import Foundation

// MARK: - WASI IO Streams

/// Input stream for reading HTTP response body data
public class WASIInputStream: NSObject {
    public var body: HTTPIncomingBody?
    
    public init(body: HTTPIncomingBody) {
        self.body = body
    }
    
    public func read(maxBytes: Int) -> Data? {
        return body?.response?.readBody(maxBytes: maxBytes)
    }
    
    /// Read data, blocking until data is available or stream is complete
    public func blockingRead(maxBytes: Int) -> Data {
        return body?.response?.readBody(maxBytes: maxBytes) ?? Data()
    }
    
    /// Check if stream has reached EOF
    public var isEOF: Bool {
        guard let response = body?.response else { return true }
        return response.streamComplete && !response.hasUnreadData
    }
}

/// Output stream for writing HTTP request body data
public class WASIOutputStream: NSObject {
    public var body: HTTPOutgoingBody?
    
    public init(body: HTTPOutgoingBody) {
        self.body = body
    }
    
    public func write(_ data: Data) {
        body?.write(data)
    }
}

/// Output stream for stderr logging
public class StderrOutputStream: NSObject {
    public override init() {
        super.init()
    }
    
    public func write(_ data: Data) {
        if let str = String(data: data, encoding: .utf8) {
            Log.wasi.info("[stderr] \(str.trimmingCharacters(in: .newlines))")
        }
    }
}

// MARK: - Process Stream Resources (Component Model)

/// Input stream for reading from a process's stdin buffer
/// Used by tsx-engine's shell:unix/command@0.1.0#run interface
public class ProcessInputStream: NSObject {
    /// Data buffer to read from
    private var buffer: [UInt8]
    private var readPosition: Int = 0
    
    public init(data: [UInt8]) {
        self.buffer = data
        super.init()
    }
    
    /// Read up to maxBytes from the buffer
    /// Returns (data, isEOF)
    public func read(maxBytes: Int) -> ([UInt8], Bool) {
        let available = buffer.count - readPosition
        if available <= 0 {
            return ([], true)  // EOF
        }
        
        let toRead = min(maxBytes, available)
        let data = Array(buffer[readPosition..<(readPosition + toRead)])
        readPosition += toRead
        
        return (data, readPosition >= buffer.count)
    }
}

/// Output stream for writing to a process's stdout/stderr buffer
/// Used by tsx-engine's shell:unix/command@0.1.0#run interface
public class ProcessOutputStream: NSObject {
    /// Callback to write data to the process buffer
    private let writeHandler: ([UInt8]) -> Void
    
    public init(writeHandler: @escaping ([UInt8]) -> Void) {
        self.writeHandler = writeHandler
        super.init()
    }
    
    /// Write data to the buffer
    public func write(_ data: [UInt8]) {
        writeHandler(data)
    }
}
