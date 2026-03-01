// net.js - Node.js net module stub for WASM sandbox
// TCP/socket operations are not available in WASM.

(function () {
    var EventEmitter = globalThis.__tsxBuiltinModules.get('events');
    if (!EventEmitter) throw new Error('net module requires events module to be loaded first');

    // --- Socket ---
    function Socket(options) {
        EventEmitter.call(this);
        this._options = options || {};
        this.readable = false;
        this.writable = false;
        this.destroyed = false;
        this.connecting = false;
        this.localAddress = undefined;
        this.localPort = undefined;
        this.remoteAddress = undefined;
        this.remoteFamily = undefined;
        this.remotePort = undefined;
        this.bytesRead = 0;
        this.bytesWritten = 0;
    }
    Socket.prototype = Object.create(EventEmitter.prototype);
    Socket.prototype.constructor = Socket;

    Socket.prototype.connect = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    Socket.prototype.write = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    Socket.prototype.end = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    Socket.prototype.destroy = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    Socket.prototype.setEncoding = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    Socket.prototype.setKeepAlive = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    Socket.prototype.setNoDelay = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    Socket.prototype.setTimeout = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    Socket.prototype.ref = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    Socket.prototype.unref = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    Socket.prototype.address = function () {
        throw new Error('net.Socket is not supported in WASM sandbox');
    };

    // --- Server ---
    function Server(options, connectionListener) {
        EventEmitter.call(this);
        if (typeof options === 'function') {
            connectionListener = options;
            options = {};
        }
        this._options = options || {};
        if (typeof connectionListener === 'function') {
            this.on('connection', connectionListener);
        }
        this.listening = false;
    }
    Server.prototype = Object.create(EventEmitter.prototype);
    Server.prototype.constructor = Server;

    Server.prototype.listen = function () {
        throw new Error('net.Server is not supported in WASM sandbox');
    };

    Server.prototype.close = function () {
        throw new Error('net.Server is not supported in WASM sandbox');
    };

    Server.prototype.address = function () {
        throw new Error('net.Server is not supported in WASM sandbox');
    };

    Server.prototype.ref = function () {
        throw new Error('net.Server is not supported in WASM sandbox');
    };

    Server.prototype.unref = function () {
        throw new Error('net.Server is not supported in WASM sandbox');
    };

    Server.prototype.getConnections = function () {
        throw new Error('net.Server is not supported in WASM sandbox');
    };

    // --- Utility functions ---

    function isIP(input) {
        if (isIPv4(input)) return 4;
        if (isIPv6(input)) return 6;
        return 0;
    }

    function isIPv4(input) {
        if (typeof input !== 'string') return false;
        var parts = input.split('.');
        if (parts.length !== 4) return false;
        for (var i = 0; i < 4; i++) {
            var part = parts[i];
            if (part.length === 0 || part.length > 3) return false;
            var num = Number(part);
            if (num !== (num | 0) || num < 0 || num > 255) return false;
            // Reject leading zeros (e.g., "01")
            if (part.length > 1 && part[0] === '0') return false;
        }
        return true;
    }

    function isIPv6(input) {
        if (typeof input !== 'string') return false;
        // Basic IPv6 validation: must contain at least one colon
        if (input.indexOf(':') === -1) return false;
        var groups = input.split(':');
        // IPv6 has 2-8 groups (:: can compress)
        if (groups.length < 2 || groups.length > 8) return false;
        var hasEmpty = false;
        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            if (g === '') {
                // Allow empty groups from :: but only one sequence of ::
                if (i > 0 && i < groups.length - 1) {
                    if (hasEmpty) return false;
                    hasEmpty = true;
                }
                continue;
            }
            if (g.length > 4) return false;
            if (!/^[0-9a-fA-F]+$/.test(g)) return false;
        }
        // Full form needs exactly 8 groups, compressed form needs fewer
        if (!hasEmpty && groups.length !== 8) return false;
        return true;
    }

    // --- Module API ---

    function createServer() {
        throw new Error('net.createServer is not supported in WASM sandbox');
    }

    function createConnection() {
        throw new Error('net.createConnection is not supported in WASM sandbox');
    }

    function connect() {
        throw new Error('net.connect is not supported in WASM sandbox');
    }

    var module = {
        createServer: createServer,
        createConnection: createConnection,
        connect: connect,
        Socket: Socket,
        Server: Server,
        isIP: isIP,
        isIPv4: isIPv4,
        isIPv6: isIPv6
    };

    globalThis.__tsxBuiltinModules.set('net', module);
    globalThis.__tsxBuiltinModules.set('node:net', module);
})();
