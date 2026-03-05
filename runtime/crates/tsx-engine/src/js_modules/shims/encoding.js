// Web API TextEncoder and TextDecoder
// Delegates to __tsxUtils__ Rust bridge for UTF-8 and base64 operations.

class TextEncoder {
    constructor(encoding = 'utf-8') {
        this.encoding = encoding.toLowerCase();
        if (this.encoding !== 'utf-8' && this.encoding !== 'utf8') {
            throw new RangeError(`The encoding "${encoding}" is not supported`);
        }
    }

    encode(string) {
        const latin1 = globalThis.__tsxUtils__.utf8Encode(String(string));
        const arr = new Uint8Array(latin1.length);
        for (let i = 0; i < latin1.length; i++) arr[i] = latin1.charCodeAt(i);
        return arr;
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

        // Skip BOM if present and not ignoring
        let start = 0;
        if (!this.ignoreBOM && bytes.length >= 3 &&
            bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
            start = 3;
        }

        // Convert bytes to latin1 string for bridge
        let latin1 = '';
        for (let i = start; i < bytes.length; i++) {
            latin1 += String.fromCharCode(bytes[i]);
        }

        return globalThis.__tsxUtils__.utf8Decode(latin1);
    }
}

// Base64 encoding/decoding (atob/btoa) — delegate to Rust bridge
globalThis.btoa = function (str) {
    return globalThis.__tsxUtils__.base64Encode(str);
};

globalThis.atob = function (str) {
    return globalThis.__tsxUtils__.base64Decode(str);
};

globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;
