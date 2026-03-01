// tty.js - Node.js tty module stub for WASM sandbox
// TTY operations are not available in WASM.

(function () {
    var EventEmitter = globalThis.__tsxBuiltinModules.get('events');
    if (!EventEmitter) throw new Error('tty module requires events module to be loaded first');

    // --- ReadStream ---
    function ReadStream(fd) {
        EventEmitter.call(this);
        this.fd = fd || 0;
        this.isRaw = false;
        this.isTTY = false;
    }
    ReadStream.prototype = Object.create(EventEmitter.prototype);
    ReadStream.prototype.constructor = ReadStream;

    ReadStream.prototype.setRawMode = function (mode) {
        this.isRaw = !!mode;
        return this;
    };

    // --- WriteStream ---
    function WriteStream(fd) {
        EventEmitter.call(this);
        this.fd = fd || 1;
        this.isTTY = false;
        this.columns = 80;
        this.rows = 24;
    }
    WriteStream.prototype = Object.create(EventEmitter.prototype);
    WriteStream.prototype.constructor = WriteStream;

    WriteStream.prototype.getColorDepth = function () {
        return 1;
    };

    WriteStream.prototype.hasColors = function (count) {
        return false;
    };

    WriteStream.prototype.getWindowSize = function () {
        return [this.columns, this.rows];
    };

    WriteStream.prototype.clearLine = function (dir, cb) {
        if (typeof cb === 'function') cb();
    };

    WriteStream.prototype.clearScreenDown = function (cb) {
        if (typeof cb === 'function') cb();
    };

    WriteStream.prototype.cursorTo = function (x, y, cb) {
        if (typeof y === 'function') {
            cb = y;
        }
        if (typeof cb === 'function') cb();
    };

    WriteStream.prototype.moveCursor = function (dx, dy, cb) {
        if (typeof cb === 'function') cb();
    };

    // --- Module API ---

    function isatty(fd) {
        return false;
    }

    var module = {
        isatty: isatty,
        ReadStream: ReadStream,
        WriteStream: WriteStream
    };

    globalThis.__tsxBuiltinModules.set('tty', module);
    globalThis.__tsxBuiltinModules.set('node:tty', module);
})();
