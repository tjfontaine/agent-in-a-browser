// worker_threads.js - Stub module for WASM sandbox
// Worker threads are not available in WASM.

(function () {
    var EventEmitter = globalThis.__tsxBuiltinModules.get('events');

    function Worker() {
        throw new Error('Worker threads are not supported in WASM sandbox');
    }
    Worker.prototype = Object.create(EventEmitter.prototype);
    Worker.prototype.constructor = Worker;

    function MessagePort() {
        EventEmitter.call(this);
    }
    MessagePort.prototype = Object.create(EventEmitter.prototype);
    MessagePort.prototype.constructor = MessagePort;
    MessagePort.prototype.postMessage = function () {
        throw new Error('MessagePort.postMessage is not supported in WASM sandbox');
    };
    MessagePort.prototype.close = function () {};
    MessagePort.prototype.ref = function () { return this; };
    MessagePort.prototype.unref = function () { return this; };

    function MessageChannel() {
        this.port1 = { postMessage: function () {}, close: function () {}, on: function () {}, once: function () {} };
        this.port2 = { postMessage: function () {}, close: function () {}, on: function () {}, once: function () {} };
    }

    var SHARE_ENV = (typeof Symbol === 'function') ? Symbol('SHARE_ENV') : 'SHARE_ENV';

    var module = {
        isMainThread: true,
        parentPort: null,
        workerData: null,
        threadId: 0,
        Worker: Worker,
        MessageChannel: MessageChannel,
        MessagePort: MessagePort,
        resourceLimits: {},
        SHARE_ENV: SHARE_ENV
    };

    globalThis.__tsxBuiltinModules.set('worker_threads', module);
    globalThis.__tsxBuiltinModules.set('node:worker_threads', module);
})();
