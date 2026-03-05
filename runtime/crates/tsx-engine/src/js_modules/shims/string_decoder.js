// string_decoder.js - Node.js string_decoder module compatible subset
// Handles incremental decoding of multi-byte character sequences.
// Delegates UTF-8 decode and base64 encode to __tsxUtils__ Rust bridge.

(function () {
    function StringDecoder(encoding) {
        this.encoding = (encoding || 'utf8').toLowerCase().replace('-', '');
        if (this.encoding === 'utf8') {
            this._buf = [];
            this._needed = 0;
        } else if (this.encoding === 'base64') {
            this._buf = [];
        }
    }

    // How many continuation bytes a UTF-8 leading byte expects
    function utf8SeqLen(b) {
        if (b < 0x80) return 1;
        if ((b & 0xE0) === 0xC0) return 2;
        if ((b & 0xF0) === 0xE0) return 3;
        if ((b & 0xF8) === 0xF0) return 4;
        return 1; // invalid, treat as single byte
    }

    function decodeUtf8Bytes(bytes) {
        var latin1 = '';
        for (var i = 0; i < bytes.length; i++) latin1 += String.fromCharCode(bytes[i]);
        return globalThis.__tsxUtils__.utf8Decode(latin1);
    }

    function bytesToBase64(bytes) {
        var latin1 = '';
        for (var i = 0; i < bytes.length; i++) latin1 += String.fromCharCode(bytes[i]);
        return globalThis.__tsxUtils__.base64Encode(latin1);
    }

    StringDecoder.prototype.write = function (buf) {
        if (!buf || buf.length === 0) return '';

        if (this.encoding === 'ascii' || this.encoding === 'latin1' || this.encoding === 'binary') {
            var s = '';
            for (var i = 0; i < buf.length; i++) {
                s += String.fromCharCode(buf[i] & 0x7F);
            }
            return s;
        }

        if (this.encoding === 'base64') {
            // Accumulate bytes, encode complete groups of 3
            for (var i = 0; i < buf.length; i++) {
                this._buf.push(buf[i]);
            }
            var complete = Math.floor(this._buf.length / 3) * 3;
            if (complete === 0) return '';
            var bytes = this._buf.splice(0, complete);
            return bytesToBase64(bytes);
        }

        // UTF-8 decoding with buffering for incomplete sequences
        var out = '';
        for (var i = 0; i < buf.length; i++) {
            var b = buf[i];
            if (this._needed > 0) {
                // Expecting continuation byte
                this._buf.push(b);
                this._needed--;
                if (this._needed === 0) {
                    out += decodeUtf8Bytes(this._buf);
                    this._buf = [];
                }
            } else {
                var seqLen = utf8SeqLen(b);
                if (seqLen === 1) {
                    out += String.fromCharCode(b);
                } else {
                    this._buf = [b];
                    this._needed = seqLen - 1;
                }
            }
        }
        return out;
    };

    StringDecoder.prototype.end = function (buf) {
        var out = '';
        if (buf) out = this.write(buf);

        if (this.encoding === 'utf8' && this._buf.length > 0) {
            // Flush incomplete sequence as replacement characters
            for (var i = 0; i < this._buf.length; i++) {
                out += '\uFFFD';
            }
            this._buf = [];
            this._needed = 0;
        }

        if (this.encoding === 'base64' && this._buf && this._buf.length > 0) {
            out += bytesToBase64(this._buf);
            this._buf = [];
        }

        return out;
    };

    var sdModule = { StringDecoder: StringDecoder };
    globalThis.__tsxBuiltinModules.set('string_decoder', sdModule);
    globalThis.__tsxBuiltinModules.set('node:string_decoder', sdModule);
})();
