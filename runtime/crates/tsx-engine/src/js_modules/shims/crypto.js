// crypto.js - Node.js crypto module compatible subset
// Hash and HMAC operations are delegated to Rust crypto crates via bridge functions.
// Encoding helpers delegate to __tsxUtils__ (Rust bridge).

(function () {
    // --- randomBytes ---
    function randomBytes(n) {
        var arr = new Uint8Array(n);
        if (typeof globalThis.__tsxGetRandomBytes__ === 'function') {
            var bytes = globalThis.__tsxGetRandomBytes__(n);
            for (var i = 0; i < n; i++) arr[i] = bytes.charCodeAt(i);
        } else {
            for (var j = 0; j < n; j++) arr[j] = Math.floor(Math.random() * 256);
        }
        return Buffer.from(arr);
    }

    // --- randomUUID ---
    function randomUUID() {
        var bytes = randomBytes(16);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        var hex = '';
        for (var i = 0; i < 16; i++) {
            hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        }
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
    }

    // --- Byte conversion helpers ---
    // Convert data to latin1 string (each char = one byte) for passing to Rust bridge
    function toLatin1(data) {
        if (typeof data === 'string') {
            return globalThis.__tsxUtils__.utf8Encode(data);
        }
        if (data && typeof data.length === 'number') {
            // Buffer or Uint8Array
            var s = '';
            for (var i = 0; i < data.length; i++) s += String.fromCharCode(data[i]);
            return s;
        }
        return String(data);
    }

    // Convert latin1 result string from Rust bridge to Uint8Array
    function fromLatin1(s) {
        var arr = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
        return arr;
    }

    // --- Supported algorithms ---
    var supportedAlgorithms = ['md5', 'sha1', 'sha-1', 'sha256', 'sha-256', 'sha512', 'sha-512'];

    // --- createHash ---
    function createHash(algorithm) {
        var algo = algorithm.toLowerCase();
        if (supportedAlgorithms.indexOf(algo) === -1) {
            throw new Error('Unsupported hash algorithm: ' + algorithm);
        }
        var chunks = [];
        var digested = false;
        return {
            update: function (data) {
                chunks.push(toLatin1(data));
                return this;
            },
            digest: function (encoding) {
                if (digested) {
                    throw new Error('Digest already called');
                }
                digested = true;
                var latin1Data = chunks.join('');
                var resultLatin1 = globalThis.__tsxHashDigest__(algo, latin1Data);
                if (resultLatin1.length === 0) {
                    throw new Error('Unsupported hash algorithm: ' + algorithm);
                }
                if (encoding === 'hex') return globalThis.__tsxUtils__.hexEncode(resultLatin1);
                if (encoding === 'base64') return globalThis.__tsxUtils__.base64Encode(resultLatin1);
                if (encoding === 'buffer' || encoding === undefined) return Buffer.from(fromLatin1(resultLatin1));
                throw new Error('Unsupported encoding: ' + encoding);
            }
        };
    }

    // --- createHmac ---
    function createHmac(algorithm, key) {
        var algo = algorithm.toLowerCase();
        if (supportedAlgorithms.indexOf(algo) === -1) {
            throw new Error('Unsupported hash algorithm: ' + algorithm);
        }
        var keyLatin1 = toLatin1(key);
        var chunks = [];
        var digested = false;
        return {
            update: function (data) {
                chunks.push(toLatin1(data));
                return this;
            },
            digest: function (encoding) {
                if (digested) {
                    throw new Error('Digest already called');
                }
                digested = true;
                var dataLatin1 = chunks.join('');
                var resultLatin1 = globalThis.__tsxHmacDigest__(algo, keyLatin1, dataLatin1);
                if (resultLatin1.length === 0) {
                    throw new Error('Unsupported hash algorithm: ' + algorithm);
                }
                if (encoding === 'hex') return globalThis.__tsxUtils__.hexEncode(resultLatin1);
                if (encoding === 'base64') return globalThis.__tsxUtils__.base64Encode(resultLatin1);
                if (encoding === 'buffer' || encoding === undefined) return Buffer.from(fromLatin1(resultLatin1));
                throw new Error('Unsupported encoding: ' + encoding);
            }
        };
    }

    // --- pbkdf2Sync ---
    // PBKDF2 uses iterative HMAC, delegated to Rust HMAC bridge
    function pbkdf2Sync(password, salt, iterations, keylen, digest) {
        if (iterations <= 0) {
            throw new Error('Iterations must be a positive number');
        }
        if (keylen === 0) {
            return Buffer.alloc(0);
        }

        var algo = (digest || 'sha1').toLowerCase();
        if (supportedAlgorithms.indexOf(algo) === -1) {
            throw new Error('Unsupported hash algorithm: ' + digest);
        }

        var keyLatin1 = toLatin1(password);
        var saltLatin1 = toLatin1(salt);

        // Determine hash output length
        var hashLen = globalThis.__tsxHashDigest__(algo, '').length;
        var numBlocks = Math.ceil(keylen / hashLen);
        var result = [];

        for (var block = 1; block <= numBlocks; block++) {
            // salt || INT_32_BE(block)
            var blockSuffix = String.fromCharCode(
                (block >>> 24) & 0xff,
                (block >>> 16) & 0xff,
                (block >>> 8) & 0xff,
                block & 0xff
            );
            var saltBlock = saltLatin1 + blockSuffix;

            // U1 = HMAC(password, salt || block)
            var u = globalThis.__tsxHmacDigest__(algo, keyLatin1, saltBlock);
            // t starts as U1 bytes
            var t = fromLatin1(u);

            for (var iter = 1; iter < iterations; iter++) {
                u = globalThis.__tsxHmacDigest__(algo, keyLatin1, u);
                var uBytes = fromLatin1(u);
                for (var k = 0; k < t.length; k++) {
                    t[k] ^= uBytes[k];
                }
            }

            for (var k = 0; k < t.length && result.length < keylen; k++) {
                result.push(t[k]);
            }
        }

        return Buffer.from(new Uint8Array(result.slice(0, keylen)));
    }

    // --- timingSafeEqual ---
    function timingSafeEqual(a, b) {
        if (a.length !== b.length) {
            throw new RangeError('Input buffers must have the same byte length');
        }
        var result = 0;
        for (var i = 0; i < a.length; i++) {
            result |= a[i] ^ b[i];
        }
        return result === 0;
    }

    var cryptoModule = {
        randomBytes: randomBytes,
        randomUUID: randomUUID,
        createHash: createHash,
        createHmac: createHmac,
        pbkdf2Sync: pbkdf2Sync,
        timingSafeEqual: timingSafeEqual,
    };

    globalThis.__tsxBuiltinModules.set('crypto', cryptoModule);
    globalThis.__tsxBuiltinModules.set('node:crypto', cryptoModule);
})();
