// tls.js - Stub module for WASM sandbox
// TLS/SSL operations are not available in WASM.

(function () {
    var EventEmitter = globalThis.__tsxBuiltinModules.get('events');
    if (!EventEmitter) throw new Error('tls module requires events module to be loaded first');

    function notSupported(name) {
        return function () {
            throw new Error('tls.' + name + ' is not supported in WASM sandbox');
        };
    }

    // --- TLSSocket ---
    function TLSSocket() {
        throw new Error('tls.TLSSocket is not supported in WASM sandbox');
    }
    TLSSocket.prototype = Object.create(EventEmitter.prototype);
    TLSSocket.prototype.constructor = TLSSocket;

    TLSSocket.prototype.getPeerCertificate = notSupported('TLSSocket.getPeerCertificate');
    TLSSocket.prototype.getCipher = notSupported('TLSSocket.getCipher');
    TLSSocket.prototype.getProtocol = notSupported('TLSSocket.getProtocol');
    TLSSocket.prototype.getSession = notSupported('TLSSocket.getSession');
    TLSSocket.prototype.renegotiate = notSupported('TLSSocket.renegotiate');
    TLSSocket.prototype.setMaxSendFragment = notSupported('TLSSocket.setMaxSendFragment');
    TLSSocket.prototype.address = notSupported('TLSSocket.address');

    // --- Server ---
    function Server() {
        throw new Error('tls.Server is not supported in WASM sandbox');
    }
    Server.prototype = Object.create(EventEmitter.prototype);
    Server.prototype.constructor = Server;

    Server.prototype.listen = notSupported('Server.listen');
    Server.prototype.close = notSupported('Server.close');
    Server.prototype.address = notSupported('Server.address');
    Server.prototype.getTicketKeys = notSupported('Server.getTicketKeys');
    Server.prototype.setTicketKeys = notSupported('Server.setTicketKeys');

    // --- Module API ---

    var module = {
        createServer: notSupported('createServer'),
        connect: notSupported('connect'),
        createSecureContext: notSupported('createSecureContext'),
        TLSSocket: TLSSocket,
        Server: Server,
        DEFAULT_MIN_VERSION: 'TLSv1.2',
        DEFAULT_MAX_VERSION: 'TLSv1.3'
    };

    globalThis.__tsxBuiltinModules.set('tls', module);
    globalThis.__tsxBuiltinModules.set('node:tls', module);
})();
