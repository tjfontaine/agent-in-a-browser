// Node.js Buffer class implementation
// Embedded via include_str! for IDE linting support

class Buffer extends Uint8Array {
    constructor(arg, encodingOrOffset, length) {
        if (typeof arg === 'number') {
            super(arg);
        } else if (typeof arg === 'string') {
            const encoding = encodingOrOffset || 'utf8';
            const bytes = Buffer._encodeString(arg, encoding);
            super(bytes);
        } else if (arg instanceof ArrayBuffer) {
            super(arg, encodingOrOffset || 0, length);
        } else if (ArrayBuffer.isView(arg)) {
            super(arg.buffer, arg.byteOffset, arg.byteLength);
        } else if (Array.isArray(arg)) {
            super(arg);
        } else {
            super(0);
        }
    }

    static from(value, encodingOrOffset, length) {
        if (typeof value === 'string') {
            return new Buffer(value, encodingOrOffset);
        }
        if (value instanceof ArrayBuffer) {
            return new Buffer(value, encodingOrOffset, length);
        }
        if (ArrayBuffer.isView(value)) {
            return new Buffer(value.buffer, value.byteOffset, value.byteLength);
        }
        if (Array.isArray(value)) {
            return new Buffer(value);
        }
        throw new TypeError('First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object');
    }

    static alloc(size, fill, encoding) {
        const buf = new Buffer(size);
        if (fill !== undefined) {
            buf.fill(fill, 0, size, encoding);
        }
        return buf;
    }

    static allocUnsafe(size) {
        return new Buffer(size);
    }

    static concat(list, totalLength) {
        if (!Array.isArray(list)) {
            throw new TypeError('list argument must be an Array');
        }

        if (list.length === 0) return Buffer.alloc(0);

        if (totalLength === undefined) {
            totalLength = list.reduce((acc, buf) => acc + buf.length, 0);
        }

        const result = Buffer.alloc(totalLength);
        let offset = 0;

        for (const buf of list) {
            result.set(buf, offset);
            offset += buf.length;
            if (offset >= totalLength) break;
        }

        return result;
    }

    static isBuffer(obj) {
        return obj instanceof Buffer;
    }

    static isEncoding(encoding) {
        return ['utf8', 'utf-8', 'hex', 'base64', 'ascii', 'latin1', 'binary'].includes(
            String(encoding).toLowerCase()
        );
    }

    static byteLength(string, encoding = 'utf8') {
        if (typeof string !== 'string') {
            return string.length;
        }
        return Buffer._encodeString(string, encoding).length;
    }

    static _encodeString(str, encoding) {
        encoding = String(encoding).toLowerCase();

        switch (encoding) {
            case 'hex':
                const hexBytes = [];
                for (let i = 0; i < str.length; i += 2) {
                    hexBytes.push(parseInt(str.substr(i, 2), 16));
                }
                return hexBytes;

            case 'base64':
                const binaryStr = atob(str);
                const base64Bytes = new Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    base64Bytes[i] = binaryStr.charCodeAt(i);
                }
                return base64Bytes;

            case 'ascii':
            case 'latin1':
            case 'binary':
                const asciiBytes = new Array(str.length);
                for (let i = 0; i < str.length; i++) {
                    asciiBytes[i] = str.charCodeAt(i) & 0xFF;
                }
                return asciiBytes;

            case 'utf8':
            case 'utf-8':
            default:
                const encoder = new TextEncoder();
                return Array.from(encoder.encode(str));
        }
    }

    toString(encoding = 'utf8', start = 0, end = this.length) {
        encoding = String(encoding).toLowerCase();
        const slice = this.subarray(start, end);

        switch (encoding) {
            case 'hex':
                return Array.from(slice)
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');

            case 'base64':
                let binary = '';
                for (let i = 0; i < slice.length; i++) {
                    binary += String.fromCharCode(slice[i]);
                }
                return btoa(binary);

            case 'ascii':
            case 'latin1':
            case 'binary':
                return Array.from(slice)
                    .map(b => String.fromCharCode(b))
                    .join('');

            case 'utf8':
            case 'utf-8':
            default:
                const decoder = new TextDecoder();
                return decoder.decode(slice);
        }
    }

    write(string, offset = 0, length, encoding = 'utf8') {
        if (typeof offset === 'string') {
            encoding = offset;
            offset = 0;
        } else if (typeof length === 'string') {
            encoding = length;
            length = undefined;
        }

        const bytes = Buffer._encodeString(string, encoding);
        const writeLength = Math.min(bytes.length, length || bytes.length, this.length - offset);

        for (let i = 0; i < writeLength; i++) {
            this[offset + i] = bytes[i];
        }

        return writeLength;
    }

    slice(start, end) {
        return new Buffer(this.buffer, this.byteOffset + (start || 0),
            (end !== undefined ? end : this.length) - (start || 0));
    }

    copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
        const len = Math.min(sourceEnd - sourceStart, target.length - targetStart);
        for (let i = 0; i < len; i++) {
            target[targetStart + i] = this[sourceStart + i];
        }
        return len;
    }

    equals(other) {
        if (this.length !== other.length) return false;
        for (let i = 0; i < this.length; i++) {
            if (this[i] !== other[i]) return false;
        }
        return true;
    }

    compare(target, targetStart = 0, targetEnd = target.length,
        sourceStart = 0, sourceEnd = this.length) {
        const targetSlice = target.subarray(targetStart, targetEnd);
        const sourceSlice = this.subarray(sourceStart, sourceEnd);

        const len = Math.min(targetSlice.length, sourceSlice.length);
        for (let i = 0; i < len; i++) {
            if (sourceSlice[i] < targetSlice[i]) return -1;
            if (sourceSlice[i] > targetSlice[i]) return 1;
        }

        if (sourceSlice.length < targetSlice.length) return -1;
        if (sourceSlice.length > targetSlice.length) return 1;
        return 0;
    }

    indexOf(value, byteOffset = 0, encoding = 'utf8') {
        if (typeof value === 'string') {
            value = Buffer.from(value, encoding);
        } else if (typeof value === 'number') {
            value = [value];
        }

        outer: for (let i = byteOffset; i <= this.length - value.length; i++) {
            for (let j = 0; j < value.length; j++) {
                if (this[i + j] !== value[j]) continue outer;
            }
            return i;
        }
        return -1;
    }

    includes(value, byteOffset, encoding) {
        return this.indexOf(value, byteOffset, encoding) !== -1;
    }

    toJSON() {
        return { type: 'Buffer', data: Array.from(this) };
    }
}

globalThis.Buffer = Buffer;
