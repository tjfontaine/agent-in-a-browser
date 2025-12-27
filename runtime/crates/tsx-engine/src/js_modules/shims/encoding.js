// Web API TextEncoder and TextDecoder
// Embedded via include_str! for IDE linting support

class TextEncoder {
    constructor(encoding = 'utf-8') {
        this.encoding = encoding.toLowerCase();
        if (this.encoding !== 'utf-8' && this.encoding !== 'utf8') {
            throw new RangeError(`The encoding "${encoding}" is not supported`);
        }
    }

    encode(string) {
        const str = String(string);
        const bytes = [];

        for (let i = 0; i < str.length; i++) {
            let codePoint = str.codePointAt(i);

            if (codePoint > 0xFFFF) {
                // Surrogate pair - skip the next char
                i++;
            }

            if (codePoint < 0x80) {
                bytes.push(codePoint);
            } else if (codePoint < 0x800) {
                bytes.push(0xC0 | (codePoint >> 6));
                bytes.push(0x80 | (codePoint & 0x3F));
            } else if (codePoint < 0x10000) {
                bytes.push(0xE0 | (codePoint >> 12));
                bytes.push(0x80 | ((codePoint >> 6) & 0x3F));
                bytes.push(0x80 | (codePoint & 0x3F));
            } else {
                bytes.push(0xF0 | (codePoint >> 18));
                bytes.push(0x80 | ((codePoint >> 12) & 0x3F));
                bytes.push(0x80 | ((codePoint >> 6) & 0x3F));
                bytes.push(0x80 | (codePoint & 0x3F));
            }
        }

        return new Uint8Array(bytes);
    }

    encodeInto(string, uint8Array) {
        const encoded = this.encode(string);
        const len = Math.min(encoded.length, uint8Array.length);
        uint8Array.set(encoded.subarray(0, len));
        return { read: string.length, written: len };
    }
}

class TextDecoder {
    constructor(encoding = 'utf-8', options = {}) {
        this.encoding = encoding.toLowerCase();
        if (this.encoding !== 'utf-8' && this.encoding !== 'utf8') {
            throw new RangeError(`The encoding "${encoding}" is not supported`);
        }
        this.fatal = options.fatal || false;
        this.ignoreBOM = options.ignoreBOM || false;
    }

    decode(input, options = {}) {
        if (!input) return '';

        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const chars = [];
        let i = 0;

        // Skip BOM if present and not ignoring
        if (!this.ignoreBOM && bytes.length >= 3 &&
            bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
            i = 3;
        }

        while (i < bytes.length) {
            const byte = bytes[i];

            if (byte < 0x80) {
                chars.push(String.fromCharCode(byte));
                i++;
            } else if ((byte & 0xE0) === 0xC0) {
                const codePoint = ((byte & 0x1F) << 6) | (bytes[i + 1] & 0x3F);
                chars.push(String.fromCharCode(codePoint));
                i += 2;
            } else if ((byte & 0xF0) === 0xE0) {
                const codePoint = ((byte & 0x0F) << 12) |
                    ((bytes[i + 1] & 0x3F) << 6) |
                    (bytes[i + 2] & 0x3F);
                chars.push(String.fromCharCode(codePoint));
                i += 3;
            } else if ((byte & 0xF8) === 0xF0) {
                const codePoint = ((byte & 0x07) << 18) |
                    ((bytes[i + 1] & 0x3F) << 12) |
                    ((bytes[i + 2] & 0x3F) << 6) |
                    (bytes[i + 3] & 0x3F);
                chars.push(String.fromCodePoint(codePoint));
                i += 4;
            } else {
                if (this.fatal) {
                    throw new TypeError('Invalid UTF-8 sequence');
                }
                chars.push('\uFFFD');
                i++;
            }
        }

        return chars.join('');
    }
}

// Base64 encoding/decoding (atob/btoa)
// These are Web API globals used by Buffer and other code
const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

globalThis.btoa = function (str) {
    let result = '';
    let i = 0;

    while (i < str.length) {
        const start = i;
        const b1 = str.charCodeAt(i++) & 0xFF;
        const b2 = i < str.length ? str.charCodeAt(i++) & 0xFF : 0;
        const b3 = i < str.length ? str.charCodeAt(i++) & 0xFF : 0;

        // How many bytes did we actually read?
        const bytesRead = i - start;

        const triplet = (b1 << 16) | (b2 << 8) | b3;

        result += base64Chars[(triplet >> 18) & 0x3F];
        result += base64Chars[(triplet >> 12) & 0x3F];
        result += bytesRead > 1 ? base64Chars[(triplet >> 6) & 0x3F] : '=';
        result += bytesRead > 2 ? base64Chars[triplet & 0x3F] : '=';
    }

    return result;
};

globalThis.atob = function (str) {
    // Remove whitespace and padding
    str = str.replace(/[\s=]/g, '');
    let result = '';

    let i = 0;
    while (i < str.length) {
        const c1 = base64Chars.indexOf(str[i++]);
        const c2 = i < str.length ? base64Chars.indexOf(str[i++]) : 0;
        const c3 = i < str.length ? base64Chars.indexOf(str[i++]) : 64; // 64 signals padding
        const c4 = i < str.length ? base64Chars.indexOf(str[i++]) : 64;

        const triplet = (c1 << 18) | (c2 << 12) | ((c3 < 64 ? c3 : 0) << 6) | (c4 < 64 ? c4 : 0);

        result += String.fromCharCode((triplet >> 16) & 0xFF);
        if (c3 < 64) {
            result += String.fromCharCode((triplet >> 8) & 0xFF);
        }
        if (c4 < 64) {
            result += String.fromCharCode(triplet & 0xFF);
        }
    }

    return result;
};

globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
