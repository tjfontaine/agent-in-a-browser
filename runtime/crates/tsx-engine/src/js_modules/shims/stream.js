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
        this.emit('close');
        if (typeof cb === 'function') cb();
        return this;
    };

    Writable.prototype.destroy = function (err) {
        this.destroyed = true;
        if (err) this.emit('error', err);
        this.emit('close');
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

    Readable.prototype.destroy = function (err) {
        this.destroyed = true;
        if (err) this.emit('error', err);
        this.emit('close');
        return this;
    };

    Readable.from = function (iterable) {
        var items = [];
        if (iterable && typeof iterable[Symbol.iterator] === 'function') {
            var iter = iterable[Symbol.iterator]();
            var item;
            while (!(item = iter.next()).done) {
                items.push(item.value);
            }
        }
        var started = false;
        var r = new Readable({
            read: function () {
                if (!started) {
                    started = true;
                    for (var i = 0; i < items.length; i++) {
                        r.push(items[i]);
                    }
                    r.push(null);
                }
            }
        });
        // Trigger read on next tick so listeners can attach first
        var origOn = r.on.bind(r);
        r.on = function (ev, fn) {
            origOn(ev, fn);
            if (ev === 'data' && !started) {
                r._read();
            }
            return r;
        };
        return r;
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
    Transform.prototype.destroy = Readable.prototype.destroy;

    // Override end to also signal readable side is done
    var _writableEnd = Writable.prototype.end;
    Transform.prototype.end = function (chunk, encoding, cb) {
        var self = this;
        _writableEnd.call(this, chunk, encoding, function () {
            // Signal readable side is done after writable finishes
            if (!self._readableState.ended) {
                self.push(null);
            }
            if (typeof cb === 'function') cb();
        });
        return this;
    };

    // --- PassThrough ---
    function PassThrough(opts) {
        Transform.call(this, Object.assign({}, opts, {
            transform: function (chunk, _enc, cb) { cb(null, chunk); }
        }));
    }
    PassThrough.prototype = Object.create(Transform.prototype);
    PassThrough.prototype.constructor = PassThrough;

    // --- Duplex ---
    function Duplex(opts) {
        Writable.call(this, opts);
        this._readableState = { ended: false, buffer: [] };
        this._read = (opts && opts.read) || function () {};
    }
    Duplex.prototype = Object.create(Writable.prototype);
    Duplex.prototype.constructor = Duplex;
    Duplex.prototype.push = Readable.prototype.push;
    Duplex.prototype.read = Readable.prototype.read;
    Duplex.prototype.pipe = Readable.prototype.pipe;

    // --- pipeline ---
    function pipeline() {
        var args = Array.prototype.slice.call(arguments);
        var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        var streams = args;

        function destroyAll(err) {
            for (var i = 0; i < streams.length; i++) {
                if (streams[i] && typeof streams[i].destroy === 'function') {
                    streams[i].destroy();
                }
            }
        }

        function onError(err) {
            destroyAll(err);
            if (cb) cb(err);
        }

        // Pipe each stream to the next
        for (var i = 0; i < streams.length - 1; i++) {
            streams[i].pipe(streams[i + 1]);
            streams[i].on('error', onError);
        }
        // Listen for error on last stream too
        streams[streams.length - 1].on('error', onError);

        // Listen for finish/end on last stream
        var last = streams[streams.length - 1];
        if (last._writableState) {
            last.on('finish', function () { if (cb) cb(null); });
        } else {
            last.on('end', function () { if (cb) cb(null); });
        }

        if (!cb) {
            return new Promise(function (resolve, reject) {
                cb = function (err) { err ? reject(err) : resolve(); };
            });
        }
    }

    // --- finished ---
    function finished(stream, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }

        function done(err) {
            if (cb) { var fn = cb; cb = null; fn(err); }
        }

        stream.on('finish', function () { done(null); });
        stream.on('end', function () { done(null); });
        stream.on('error', function (err) { done(err); });
        stream.on('close', function () { done(null); });

        return function cleanup() { cb = null; };
    }

    var streamModule = {
        Readable: Readable,
        Writable: Writable,
        Transform: Transform,
        PassThrough: PassThrough,
        Duplex: Duplex,
        Stream: EventEmitter,
        pipeline: pipeline,
        finished: finished,
    };

    globalThis.__tsxBuiltinModules.set('stream', streamModule);
    globalThis.__tsxBuiltinModules.set('node:stream', streamModule);
})();
