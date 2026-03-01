// dgram.js - Stub module for WASM sandbox
// UDP/datagram operations are not available in WASM.

(function () {
    var EventEmitter = globalThis.__tsxBuiltinModules.get('events');
    if (!EventEmitter) throw new Error('dgram module requires events module to be loaded first');

    function notSupported(name) {
        return function () {
            throw new Error('dgram.' + name + ' is not supported in WASM sandbox');
        };
    }

    // --- Socket ---
    // Stub dgram.Socket extending EventEmitter.
    // All methods throw because UDP is not available in WASM.
    function Socket(type, listener) {
        EventEmitter.call(this);
        this.type = type || 'udp4';
        if (typeof listener === 'function') {
            this.on('message', listener);
        }
    }
    Socket.prototype = Object.create(EventEmitter.prototype);
    Socket.prototype.constructor = Socket;

    Socket.prototype.bind = notSupported('Socket.bind');
    Socket.prototype.send = notSupported('Socket.send');
    Socket.prototype.close = notSupported('Socket.close');
    Socket.prototype.address = notSupported('Socket.address');
    Socket.prototype.setBroadcast = notSupported('Socket.setBroadcast');
    Socket.prototype.setMulticastTTL = notSupported('Socket.setMulticastTTL');
    Socket.prototype.setMulticastLoopback = notSupported('Socket.setMulticastLoopback');
    Socket.prototype.addMembership = notSupported('Socket.addMembership');
    Socket.prototype.dropMembership = notSupported('Socket.dropMembership');
    Socket.prototype.ref = notSupported('Socket.ref');
    Socket.prototype.unref = notSupported('Socket.unref');

    // --- Module API ---

    function createSocket() {
        throw new Error('dgram.createSocket is not supported in WASM sandbox');
    }

    var module = {
        createSocket: createSocket,
        Socket: Socket
    };

    globalThis.__tsxBuiltinModules.set('dgram', module);
    globalThis.__tsxBuiltinModules.set('node:dgram', module);
})();
