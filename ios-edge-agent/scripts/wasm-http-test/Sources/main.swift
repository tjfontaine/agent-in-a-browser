import Foundation
import WasmKit
import WasmKitWASI

// MARK: - Simple MCP Server

final class SimpleMCPServer: @unchecked Sendable {
    private var listener: Task<Void, Never>?
    let port: UInt16 = 9393
    
    var baseURL: String { "http://localhost:\(port)" }
    
    func start() async throws {
        print("[MCPServer] Starting on \(baseURL)")
        let server = try ServerSocket(port: port)
        
        listener = Task {
            while !Task.isCancelled {
                do {
                    let client = try await server.accept()
                    Task {
                        await self.handleConnection(client)
                    }
                } catch {
                    if !Task.isCancelled {
                        print("[MCPServer] Accept error: \(error)")
                    }
                }
            }
        }
        
        print("[MCPServer] Ready")
    }
    
    func stop() {
        listener?.cancel()
    }
    
    private func handleConnection(_ client: ClientSocket) async {
        do {
            let request = try await client.readHTTPRequest()
            print("[MCPServer] Received: \(request.body)")
            let response = handleJSONRPC(request.body)
            try await client.sendHTTPResponse(status: 200, body: response)
            print("[MCPServer] Sent response")
        } catch {
            print("[MCPServer] Error: \(error)")
        }
    }
    
    private func handleJSONRPC(_ body: String) -> String {
        return """
        {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"test_tool","description":"A test tool","inputSchema":{"type":"object","properties":{}}}]}}
        """
    }
}

// MARK: - Simple Socket Helpers

final class ServerSocket: @unchecked Sendable {
    private var socketFD: Int32 = -1
    
    init(port: UInt16) throws {
        socketFD = socket(AF_INET, SOCK_STREAM, 0)
        guard socketFD >= 0 else { throw NSError(domain: "socket", code: Int(errno)) }
        
        var opt: Int32 = 1
        setsockopt(socketFD, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))
        
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = INADDR_ANY
        
        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            close(socketFD)
            throw NSError(domain: "bind", code: Int(errno))
        }
        
        guard listen(socketFD, 5) == 0 else {
            close(socketFD)
            throw NSError(domain: "listen", code: Int(errno))
        }
    }
    
    func accept() async throws -> ClientSocket {
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global().async {
                var clientAddr = sockaddr_in()
                var addrLen = socklen_t(MemoryLayout<sockaddr_in>.size)
                let clientFD = withUnsafeMutablePointer(to: &clientAddr) {
                    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                        Darwin.accept(self.socketFD, $0, &addrLen)
                    }
                }
                if clientFD >= 0 {
                    continuation.resume(returning: ClientSocket(fd: clientFD))
                } else {
                    continuation.resume(throwing: NSError(domain: "accept", code: Int(errno)))
                }
            }
        }
    }
    
    deinit {
        if socketFD >= 0 { close(socketFD) }
    }
}

final class ClientSocket: @unchecked Sendable {
    private let fd: Int32
    
    init(fd: Int32) { self.fd = fd }
    
    func readHTTPRequest() async throws -> (headers: String, body: String) {
        var buffer = [UInt8](repeating: 0, count: 8192)
        let bytesRead = read(fd, &buffer, buffer.count)
        guard bytesRead > 0 else { throw NSError(domain: "read", code: Int(errno)) }
        
        let data = String(bytes: buffer[0..<bytesRead], encoding: .utf8) ?? ""
        let parts = data.components(separatedBy: "\r\n\r\n")
        return (parts.first ?? "", parts.count > 1 ? parts[1] : "")
    }
    
    func sendHTTPResponse(status: Int, body: String) async throws {
        let response = "HTTP/1.1 \(status) OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        let data = Array(response.utf8)
        _ = write(fd, data, data.count)
    }
    
    deinit { close(fd) }
}

// MARK: - Resource Registry

final class ResourceRegistry: @unchecked Sendable {
    private var resources: [Int32: Any] = [:]
    private var nextHandle: Int32 = 1
    
    func register<T: AnyObject>(_ resource: T) -> Int32 {
        let handle = nextHandle
        nextHandle += 1
        resources[handle] = resource
        print("[Registry] Registered handle \(handle) -> \(type(of: resource))")
        return handle
    }
    
    func get<T: AnyObject>(_ handle: Int32) -> T? {
        let result = resources[handle] as? T
        if result == nil {
            print("[Registry] Handle \(handle) not found or wrong type (looking for \(T.self))")
        }
        return result
    }
    
    func drop(_ handle: Int32) {
        resources.removeValue(forKey: handle)
    }
}

// MARK: - HTTP Types

final class FutureIncomingResponse: @unchecked Sendable {
    var response: HTTPIncomingResponse?
    var error: String?
    let semaphore = DispatchSemaphore(value: 0)
    
    var isReady: Bool { response != nil || error != nil }
    
    func signalReady() { semaphore.signal() }
    
    func waitForReady(timeout: TimeInterval = 30) -> Bool {
        if isReady { return true }
        let result = semaphore.wait(timeout: .now() + timeout)
        return result == .success || isReady
    }
}

final class HTTPIncomingResponse: Sendable {
    let status: Int
    let headers: [(String, String)]
    let body: Data
    
    init(status: Int, headers: [(String, String)], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }
}

final class HTTPPollable: @unchecked Sendable {
    weak var future: FutureIncomingResponse?
    
    init(future: FutureIncomingResponse) { self.future = future }
    
    var isReady: Bool { future?.isReady ?? true }
    
    func block(timeout: TimeInterval = 30) {
        guard let future = future else { return }
        _ = future.waitForReady(timeout: timeout)
    }
}

final class HTTPOutgoingRequest: @unchecked Sendable {
    var method: String = "GET"
    var scheme: String = "http"
    var authority: String = ""
    var path: String = "/"
    var headersHandle: Int32 = 0
    var body: Data = Data()
}

final class HTTPFields: @unchecked Sendable {
    var entries: [(String, String)] = []
}

// MARK: - HTTP Request Manager

final class HTTPRequestManager: @unchecked Sendable {
    private let session: URLSession
    
    init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        self.session = URLSession(configuration: config)
    }
    
    func performRequest(method: String, url: String, headers: [(String, String)], body: Data?, future: FutureIncomingResponse) {
        guard let requestURL = URL(string: url) else {
            future.error = "Invalid URL"
            future.signalReady()
            return
        }
        
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        for (name, value) in headers {
            request.addValue(value, forHTTPHeaderField: name)
        }
        request.httpBody = body
        
        print("[HTTP] Starting request: \(method) \(url)")
        
        let task = session.dataTask(with: request) { data, response, error in
            if let error = error {
                print("[HTTP] Error: \(error)")
                future.error = error.localizedDescription
                future.signalReady()
                return
            }
            
            guard let httpResponse = response as? HTTPURLResponse else {
                future.error = "Invalid response"
                future.signalReady()
                return
            }
            
            print("[HTTP] Response: \(httpResponse.statusCode)")
            
            var responseHeaders: [(String, String)] = []
            for (key, value) in httpResponse.allHeaderFields {
                if let k = key as? String, let v = value as? String {
                    responseHeaders.append((k, v))
                }
            }
            
            future.response = HTTPIncomingResponse(
                status: httpResponse.statusCode,
                headers: responseHeaders,
                body: data ?? Data()
            )
            future.signalReady()
        }
        
        task.resume()
    }
}

// MARK: - WASM Test Harness

@main
struct WASMHTTPTest {
    static let resources = ResourceRegistry()
    static let httpManager = HTTPRequestManager()
    
    static func main() async throws {
        print("=== WASM HTTP Integration Test ===\n")
        
        // Find the WASM module
        let wasmPath = CommandLine.arguments.count > 1 
            ? CommandLine.arguments[1]
            : "../EdgeAgent/Resources/WebRuntime/web-headless-agent-sync/web-headless-agent-ios.core.wasm"
        
        print("Looking for WASM at: \(wasmPath)")
        
        // Test 1: Basic semaphore test (no WASM)
        print("\n--- Test 1: Semaphore synchronization ---")
        try await testSemaphoreSync()
        
        // Test 2: HTTP with semaphore (no WASM)
        print("\n--- Test 2: HTTP with semaphore ---")
        try await testHTTPWithSemaphore()
        
        // Test 3: Memory layout test
        print("\n--- Test 3: Memory layout for result<own<T>, E> ---")
        testMemoryLayout()
        
        // Test 4: Load WASM if available
        print("\n--- Test 4: WASM module loading ---")
        await testWASMLoading(path: wasmPath)
        
        print("\n=== Tests complete ===")
    }
    
    static func testSemaphoreSync() async throws {
        let future = FutureIncomingResponse()
        let pollable = HTTPPollable(future: future)
        
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
            print("  [Background] Setting response")
            future.response = HTTPIncomingResponse(status: 200, headers: [], body: Data())
            future.signalReady()
        }
        
        print("  [Main] Waiting for response...")
        pollable.block(timeout: 5)
        
        if pollable.isReady {
            print("  ✅ Semaphore sync works!")
        } else {
            print("  ❌ Semaphore sync failed - timeout")
        }
    }
    
    static func testHTTPWithSemaphore() async throws {
        let server = SimpleMCPServer()
        try await server.start()
        try await Task.sleep(nanoseconds: 100_000_000)
        
        let future = FutureIncomingResponse()
        let futureHandle = resources.register(future)
        
        httpManager.performRequest(
            method: "POST",
            url: server.baseURL,
            headers: [("Content-Type", "application/json")],
            body: "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}".data(using: .utf8),
            future: future
        )
        
        // Simulate WASI flow
        print("  [WASI] subscribe(futureHandle=\(futureHandle))")
        let pollable = HTTPPollable(future: future)
        let pollableHandle = resources.register(pollable)
        
        print("  [WASI] block(pollableHandle=\(pollableHandle))")
        if let p: HTTPPollable = resources.get(pollableHandle) {
            p.block(timeout: 10)
        } else {
            print("  ❌ Pollable not found!")
        }
        
        print("  [WASI] get(futureHandle=\(futureHandle))")
        if let f: FutureIncomingResponse = resources.get(futureHandle) {
            if let response = f.response {
                print("  ✅ HTTP succeeded! Status: \(response.status)")
            } else if let error = f.error {
                print("  ❌ HTTP error: \(error)")
            } else {
                print("  ❌ No response")
            }
        }
        
        server.stop()
    }
    
    static func testMemoryLayout() {
        // Simulate the memory layout for result<own<future-incoming-response>, error-code>
        var buffer = [UInt8](repeating: 0xFF, count: 8)  // Fill with 0xFF to see what we write
        
        let futureHandle: Int32 = 6
        
        // Layout according to canonical ABI:
        // - discriminant: 1 byte (cases < 256 → u8)
        // - padding: 3 bytes (to align payload to 4)
        // - payload: 4 bytes
        
        // Write discriminant (0 = Ok)
        buffer[0] = 0
        
        // Write handle at offset 4
        let handleBytes = withUnsafeBytes(of: UInt32(bitPattern: futureHandle).littleEndian) { Array($0) }
        for (i, byte) in handleBytes.enumerated() {
            buffer[4 + i] = byte
        }
        
        print("  Memory bytes: \(buffer)")
        print("  Expected: [0, 0, 0, 0, 6, 0, 0, 0] (if we clear padding)")
        print("  Or:       [0, 255, 255, 255, 6, 0, 0, 0] (if we only write what we need)")
        
        // Read back as WASM would
        let discriminant = buffer[0]
        let payload = buffer.withUnsafeBytes { ptr -> UInt32 in
            ptr.load(fromByteOffset: 4, as: UInt32.self)
        }
        
        print("  Read discriminant: \(discriminant) (expect 0)")
        print("  Read payload: \(payload) (expect 6)")
        
        if discriminant == 0 && payload == 6 {
            print("  ✅ Memory layout correct!")
        } else {
            print("  ❌ Memory layout issue")
        }
    }
    
    static func testWASMLoading(path: String) async {
        let fileManager = FileManager.default
        let fullPath = fileManager.currentDirectoryPath + "/" + path
        
        if !fileManager.fileExists(atPath: fullPath) {
            print("  ⚠️ WASM file not found at: \(fullPath)")
            print("  Run with: swift run wasm-http-test <path-to-wasm>")
            return
        }
        
        do {
            print("  Loading WASM from: \(fullPath)")
            let wasmBytes = try Data(contentsOf: URL(fileURLWithPath: fullPath))
            print("  ✅ Read \(wasmBytes.count) bytes")
            
            // Parse the module to check imports
            let module = try parseWasm(bytes: Array(wasmBytes))
            print("  ✅ Parsed WASM module")
            
            // List imports
            print("  Module imports:")
            for imp in module.imports.prefix(20) {
                print("    - \(imp.module)::\(imp.name)")
            }
            if module.imports.count > 20 {
                print("    ... and \(module.imports.count - 20) more")
            }
            
        } catch {
            print("  ❌ Failed to load WASM: \(error)")
        }
    }
}
