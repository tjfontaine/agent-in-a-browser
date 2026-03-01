// crypto.js - Node.js crypto module compatible subset

(function () {
    // --- randomBytes ---
    function randomBytes(n) {
        var arr = new Uint8Array(n);
        // Use Rust-provided random bytes if available, otherwise Math.random fallback
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
        // Set version 4 (bits 12-15 of time_hi_and_version)
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        // Set variant (bits 6-7 of clk_seq_hi_res)
        bytes[8] = (bytes[8] & 0x3f) | 0x80;

        var hex = '';
        for (var i = 0; i < 16; i++) {
            hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        }
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
    }

    // --- SHA-256 (pure JS) ---
    var SHA256_K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);

    function sha256(data) {
        // Convert string to bytes
        var bytes;
        if (typeof data === 'string') {
            bytes = [];
            for (var ci = 0; ci < data.length; ci++) {
                var code = data.charCodeAt(ci);
                if (code < 0x80) {
                    bytes.push(code);
                } else if (code < 0x800) {
                    bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
                } else if (code < 0xd800 || code >= 0xe000) {
                    bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
                } else {
                    ci++;
                    code = 0x10000 + (((code & 0x3ff) << 10) | (data.charCodeAt(ci) & 0x3ff));
                    bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
                }
            }
        } else {
            bytes = Array.from(data);
        }

        var len = bytes.length;
        // Pre-processing: adding padding bits
        bytes.push(0x80);
        while ((bytes.length % 64) !== 56) bytes.push(0);
        // Append original length in bits as 64-bit big-endian
        var bitLen = len * 8;
        for (var s = 56; s >= 0; s -= 8) bytes.push((bitLen / Math.pow(2, s)) & 0xff);

        // Initialize hash values
        var h0 = 0x6a09e667 | 0, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372 | 0, h3 = 0xa54ff53a | 0;
        var h4 = 0x510e527f | 0, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab | 0, h7 = 0x5be0cd19 | 0;

        var w = new Int32Array(64);

        // Process each 64-byte chunk
        for (var off = 0; off < bytes.length; off += 64) {
            for (var i = 0; i < 16; i++) {
                w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
            }
            for (var i = 16; i < 64; i++) {
                var s0 = ((w[i-15] >>> 7) | (w[i-15] << 25)) ^ ((w[i-15] >>> 18) | (w[i-15] << 14)) ^ (w[i-15] >>> 3);
                var s1 = ((w[i-2] >>> 17) | (w[i-2] << 15)) ^ ((w[i-2] >>> 19) | (w[i-2] << 13)) ^ (w[i-2] >>> 10);
                w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
            }

            var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

            for (var i = 0; i < 64; i++) {
                var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
                var ch = (e & f) ^ (~e & g);
                var temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
                var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var temp2 = (S0 + maj) | 0;

                h = g; g = f; f = e; e = (d + temp1) | 0;
                d = c; c = b; b = a; a = (temp1 + temp2) | 0;
            }

            h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
            h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
        }

        return new Uint8Array([
            (h0 >>> 24) & 0xff, (h0 >>> 16) & 0xff, (h0 >>> 8) & 0xff, h0 & 0xff,
            (h1 >>> 24) & 0xff, (h1 >>> 16) & 0xff, (h1 >>> 8) & 0xff, h1 & 0xff,
            (h2 >>> 24) & 0xff, (h2 >>> 16) & 0xff, (h2 >>> 8) & 0xff, h2 & 0xff,
            (h3 >>> 24) & 0xff, (h3 >>> 16) & 0xff, (h3 >>> 8) & 0xff, h3 & 0xff,
            (h4 >>> 24) & 0xff, (h4 >>> 16) & 0xff, (h4 >>> 8) & 0xff, h4 & 0xff,
            (h5 >>> 24) & 0xff, (h5 >>> 16) & 0xff, (h5 >>> 8) & 0xff, h5 & 0xff,
            (h6 >>> 24) & 0xff, (h6 >>> 16) & 0xff, (h6 >>> 8) & 0xff, h6 & 0xff,
            (h7 >>> 24) & 0xff, (h7 >>> 16) & 0xff, (h7 >>> 8) & 0xff, h7 & 0xff,
        ]);
    }

    // --- Hex and Base64 encoding ---
    function toHex(bytes) {
        var hex = '';
        for (var i = 0; i < bytes.length; i++) {
            hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        }
        return hex;
    }

    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    function toBase64(bytes) {
        var result = '';
        for (var i = 0; i < bytes.length; i += 3) {
            var a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
            var triple = (a << 16) | ((b || 0) << 8) | (c || 0);
            result += B64[(triple >> 18) & 63];
            result += B64[(triple >> 12) & 63];
            result += (i + 1 < bytes.length) ? B64[(triple >> 6) & 63] : '=';
            result += (i + 2 < bytes.length) ? B64[triple & 63] : '=';
        }
        return result;
    }

    // --- createHash ---
    function createHash(algorithm) {
        var algo = algorithm.toLowerCase();
        if (algo !== 'sha256' && algo !== 'sha-256') {
            throw new Error('Unsupported hash algorithm: ' + algorithm + '. Only sha256 is supported.');
        }
        var chunks = [];
        return {
            update: function (data) {
                chunks.push(typeof data === 'string' ? data : String(data));
                return this;
            },
            digest: function (encoding) {
                var input = chunks.join('');
                var hashBytes = sha256(input);
                if (encoding === 'hex') return toHex(hashBytes);
                if (encoding === 'base64') return toBase64(hashBytes);
                if (encoding === 'buffer' || encoding === undefined) return Buffer.from(hashBytes);
                throw new Error('Unsupported encoding: ' + encoding);
            }
        };
    }

    var cryptoModule = {
        randomBytes: randomBytes,
        randomUUID: randomUUID,
        createHash: createHash,
    };

    globalThis.__tsxBuiltinModules.set('crypto', cryptoModule);
    globalThis.__tsxBuiltinModules.set('node:crypto', cryptoModule);
})();
