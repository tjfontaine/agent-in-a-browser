// zlib.js - Node.js zlib module stubs for WASM sandbox
// Provides identity-transform streams and constants (no actual compression).

(function () {
    var streamModule = globalThis.__tsxBuiltinModules.get('stream');
    if (!streamModule) throw new Error('zlib module requires stream module to be loaded first');

    var Transform = streamModule.Transform;

    // --- Constants ---
    var constants = {
        Z_NO_COMPRESSION: 0,
        Z_BEST_SPEED: 1,
        Z_BEST_COMPRESSION: 9,
        Z_DEFAULT_COMPRESSION: -1,
        Z_NO_FLUSH: 0,
        Z_SYNC_FLUSH: 2,
        Z_FULL_FLUSH: 3,
        Z_FINISH: 4
    };

    // --- Identity Transform base ---
    // All zlib transform classes pass data through unchanged.

    function ZlibStub(opts) {
        Transform.call(this, {
            transform: function (chunk, _enc, cb) {
                cb(null, chunk);
            }
        });
    }
    ZlibStub.prototype = Object.create(Transform.prototype);
    ZlibStub.prototype.constructor = ZlibStub;

    // --- Transform stream classes ---

    function Gzip(opts) { ZlibStub.call(this, opts); }
    Gzip.prototype = Object.create(ZlibStub.prototype);
    Gzip.prototype.constructor = Gzip;

    function Gunzip(opts) { ZlibStub.call(this, opts); }
    Gunzip.prototype = Object.create(ZlibStub.prototype);
    Gunzip.prototype.constructor = Gunzip;

    function Deflate(opts) { ZlibStub.call(this, opts); }
    Deflate.prototype = Object.create(ZlibStub.prototype);
    Deflate.prototype.constructor = Deflate;

    function Inflate(opts) { ZlibStub.call(this, opts); }
    Inflate.prototype = Object.create(ZlibStub.prototype);
    Inflate.prototype.constructor = Inflate;

    function DeflateRaw(opts) { ZlibStub.call(this, opts); }
    DeflateRaw.prototype = Object.create(ZlibStub.prototype);
    DeflateRaw.prototype.constructor = DeflateRaw;

    function InflateRaw(opts) { ZlibStub.call(this, opts); }
    InflateRaw.prototype = Object.create(ZlibStub.prototype);
    InflateRaw.prototype.constructor = InflateRaw;

    function BrotliCompress(opts) { ZlibStub.call(this, opts); }
    BrotliCompress.prototype = Object.create(ZlibStub.prototype);
    BrotliCompress.prototype.constructor = BrotliCompress;

    function BrotliDecompress(opts) { ZlibStub.call(this, opts); }
    BrotliDecompress.prototype = Object.create(ZlibStub.prototype);
    BrotliDecompress.prototype.constructor = BrotliDecompress;

    // --- Factory functions ---

    function createGzip(opts) { return new Gzip(opts); }
    function createGunzip(opts) { return new Gunzip(opts); }
    function createDeflate(opts) { return new Deflate(opts); }
    function createInflate(opts) { return new Inflate(opts); }
    function createDeflateRaw(opts) { return new DeflateRaw(opts); }
    function createInflateRaw(opts) { return new InflateRaw(opts); }
    function createBrotliCompress(opts) { return new BrotliCompress(opts); }
    function createBrotliDecompress(opts) { return new BrotliDecompress(opts); }

    // --- Convenience callback functions (passthrough) ---

    function gzip(buf, cb) { cb(null, buf); }
    function gunzip(buf, cb) { cb(null, buf); }
    function deflate(buf, cb) { cb(null, buf); }
    function inflate(buf, cb) { cb(null, buf); }
    function deflateRaw(buf, cb) { cb(null, buf); }
    function inflateRaw(buf, cb) { cb(null, buf); }
    function brotliCompress(buf, cb) { cb(null, buf); }
    function brotliDecompress(buf, cb) { cb(null, buf); }

    // --- Sync convenience functions (passthrough) ---

    function gzipSync(buf) { return buf; }
    function gunzipSync(buf) { return buf; }
    function deflateSync(buf) { return buf; }
    function inflateSync(buf) { return buf; }
    function deflateRawSync(buf) { return buf; }
    function inflateRawSync(buf) { return buf; }
    function brotliCompressSync(buf) { return buf; }
    function brotliDecompressSync(buf) { return buf; }

    // --- Module export ---

    var zlibModule = {
        // Constants (top-level and nested)
        constants: constants,
        Z_NO_COMPRESSION: constants.Z_NO_COMPRESSION,
        Z_BEST_SPEED: constants.Z_BEST_SPEED,
        Z_BEST_COMPRESSION: constants.Z_BEST_COMPRESSION,
        Z_DEFAULT_COMPRESSION: constants.Z_DEFAULT_COMPRESSION,
        Z_NO_FLUSH: constants.Z_NO_FLUSH,
        Z_SYNC_FLUSH: constants.Z_SYNC_FLUSH,
        Z_FULL_FLUSH: constants.Z_FULL_FLUSH,
        Z_FINISH: constants.Z_FINISH,

        // Classes
        Gzip: Gzip,
        Gunzip: Gunzip,
        Deflate: Deflate,
        Inflate: Inflate,
        DeflateRaw: DeflateRaw,
        InflateRaw: InflateRaw,
        BrotliCompress: BrotliCompress,
        BrotliDecompress: BrotliDecompress,

        // Factory functions
        createGzip: createGzip,
        createGunzip: createGunzip,
        createDeflate: createDeflate,
        createInflate: createInflate,
        createDeflateRaw: createDeflateRaw,
        createInflateRaw: createInflateRaw,
        createBrotliCompress: createBrotliCompress,
        createBrotliDecompress: createBrotliDecompress,

        // Callback convenience functions
        gzip: gzip,
        gunzip: gunzip,
        deflate: deflate,
        inflate: inflate,
        deflateRaw: deflateRaw,
        inflateRaw: inflateRaw,
        brotliCompress: brotliCompress,
        brotliDecompress: brotliDecompress,

        // Sync convenience functions
        gzipSync: gzipSync,
        gunzipSync: gunzipSync,
        deflateSync: deflateSync,
        inflateSync: inflateSync,
        deflateRawSync: deflateRawSync,
        inflateRawSync: inflateRawSync,
        brotliCompressSync: brotliCompressSync,
        brotliDecompressSync: brotliDecompressSync
    };

    globalThis.__tsxBuiltinModules.set('zlib', zlibModule);
    globalThis.__tsxBuiltinModules.set('node:zlib', zlibModule);
})();
