/// SocketsProvider.swift
/// Type-safe WASI import provider for wasi:sockets interfaces
///
/// Uses MCPSignatures constants for ABI-correct function signatures.

import WasmKit
import OSLog

/// Provides type-safe WASI imports for sockets interfaces.
/// Note: iOS doesn't support full sockets, so these are stubs.
struct SocketsProvider: WASIProvider {
    static var moduleName: String { "wasi:sockets" }
    
    /// All imports declared by this provider for compile-time validation
    var declaredImports: [WASIImportDeclaration] {
        [
            WASIImportDeclaration(module: "wasi:sockets/tcp@0.2.0", name: "[resource-drop]tcp-socket", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:sockets/udp@0.2.0", name: "[resource-drop]udp-socket", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:sockets/udp@0.2.0", name: "[resource-drop]incoming-datagram-stream", parameters: [.i32], results: []),
            WASIImportDeclaration(module: "wasi:sockets/udp@0.2.0", name: "[resource-drop]outgoing-datagram-stream", parameters: [.i32], results: []),
        ]
    }
    
    private let resources: ResourceRegistry
    
    private typealias TcpSig = MCPSignatures.sockets_tcp_0_2_0
    private typealias UdpSig = MCPSignatures.sockets_udp_0_2_0
    
    init(resources: ResourceRegistry) {
        self.resources = resources
    }
    
    func register(into imports: inout Imports, store: Store) {
        let resources = self.resources
        
        // wasi:sockets/tcp@0.2.0
        let tcpModule = "wasi:sockets/tcp@0.2.0"
        
        imports.define(module: tcpModule, name: "[resource-drop]tcp-socket",
            Function(store: store, parameters: TcpSig.resource_droptcp_socket.parameters, results: TcpSig.resource_droptcp_socket.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        // wasi:sockets/udp@0.2.0
        let udpModule = "wasi:sockets/udp@0.2.0"
        
        imports.define(module: udpModule, name: "[resource-drop]udp-socket",
            Function(store: store, parameters: UdpSig.resource_dropudp_socket.parameters, results: UdpSig.resource_dropudp_socket.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: udpModule, name: "[resource-drop]incoming-datagram-stream",
            Function(store: store, parameters: UdpSig.resource_dropincoming_datagram_stream.parameters, results: UdpSig.resource_dropincoming_datagram_stream.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
        
        imports.define(module: udpModule, name: "[resource-drop]outgoing-datagram-stream",
            Function(store: store, parameters: UdpSig.resource_dropoutgoing_datagram_stream.parameters, results: UdpSig.resource_dropoutgoing_datagram_stream.results) { _, args in
                resources.drop(Int32(bitPattern: args[0].i32))
                return []
            }
        )
    }
}
