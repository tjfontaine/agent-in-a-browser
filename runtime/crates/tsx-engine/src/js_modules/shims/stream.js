// stream.js - Node.js stream module compatible subset
// Lightweight Readable, Writable, Transform, PassThrough extending EventEmitter

(function () {
    var EventEmitter = globalThis.__tsxBuiltinModules.get('events');
    if (!EventEmitter) throw new Error('stream module requires events module to be loaded first');

    // --- Writable ---
    function Writable(opts) {
        EventEmitter.call(this);
        this._writableState = { ended: false, writing: false };
        this._write = (opts && opts.write) || function (_chunk, _enc, cb) { cb(); };
    }
    Writable.prototype = Object.create(EventEmitter.prototype);
    Writable.prototype.constructor = Writable;

    Writable.prototype.write = function (chunk, encoding, cb) {
        if (typeof encoding === 'function') { cb = encoding; encoding = 'utf8'; }
        var self = this;
        this._write(chunk, encoding || 'utf8', function (err) {
            if (err) self.emit('error', err);
            if (typeof cb === 'function') cb(err);
        });
        return true;
    };

    Writable.prototype.end = function (chunk, encoding, cb) {
        if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = null; }
        if (typeof encoding === 'function') { cb = encoding; encoding = null; }
        if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);
        this._writableState.ended = true;
        this.emit('finish');
        if (typeof cb === 'function') cb();
        return this;
    };

    // --- Readable ---
    function Readable(opts) {
        EventEmitter.call(this);
        this._readableState = { ended: false, buffer: [] };
        this._read = (opts && opts.read) || function () {};
    }
    Readable.prototype = Object.create(EventEmitter.prototype);
    Readable.prototype.constructor = Readable;

    Readable.prototype.push = function (chunk) {
        if (chunk === null) {
            this._readableState.ended = true;
            this.emit('end');
            return false;
        }
        this._readableState.buffer.push(chunk);
        this.emit('data', chunk);
        return true;
    };

    Readable.prototype.read = function () {
        if (this._readableState.buffer.length > 0) {
            return this._readableState.buffer.shift();
        }
        return null;
    };

    Readable.prototype.pipe = function (dest) {
        var src = this;
        src.on('data', function (chunk) { dest.write(chunk); });
        src.on('end', function () { dest.end(); });
        return dest;
    };

    // --- Transform ---
    function Transform(opts) {
        Writable.call(this, {
            write: function (chunk, enc, cb) {
                self._transform(chunk, enc, function (err, data) {
                    if (data !== undefined && data !== null) self.push(data);
                    cb(err);
                });
            }
        });
        // Also set up Readable state
        this._readableState = { ended: false, buffer: [] };
        var self = this;
        this._transform = (opts && opts.transform) || function (chunk, _enc, cb) { cb(null, chunk); };
    }
    Transform.prototype = Object.create(Writable.prototype);
    Transform.prototype.constructor = Transform;
    Transform.prototype.push = Readable.prototype.push;
    Transform.prototype.pipe = Readable.prototype.pipe;

    // --- PassThrough ---
    function PassThrough(opts) {
        Transform.call(this, Object.assign({}, opts, {
            transform: function (chunk, _enc, cb) { cb(null, chunk); }
        }));
    }
    PassThrough.prototype = Object.create(Transform.prototype);
    PassThrough.prototype.constructor = PassThrough;

    var streamModule = {
        Readable: Readable,
        Writable: Writable,
        Transform: Transform,
        PassThrough: PassThrough,
        Stream: EventEmitter,
    };

    globalThis.__tsxBuiltinModules.set('stream', streamModule);
    globalThis.__tsxBuiltinModules.set('node:stream', streamModule);
})();
