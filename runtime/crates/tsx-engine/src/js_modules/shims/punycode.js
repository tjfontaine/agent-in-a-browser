// Node.js punycode module shim
// Implements RFC 3492 Punycode encoding for internationalized domain names.
// Embedded via include_str! for IDE linting support

(function() {
    var BASE = 36;
    var TMIN = 1;
    var TMAX = 26;
    var SKEW = 38;
    var DAMP = 700;
    var INITIAL_BIAS = 72;
    var INITIAL_N = 128;
    var DELIMITER = '-';

    function error(type) {
        throw new RangeError('punycode: ' + type);
    }

    // UCS-2 helpers: decode a string into an array of codepoints
    function ucs2decode(str) {
        var output = [];
        var counter = 0;
        var length = str.length;
        while (counter < length) {
            var value = str.charCodeAt(counter++);
            if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
                // high surrogate
                var extra = str.charCodeAt(counter++);
                if ((extra & 0xFC00) === 0xDC00) {
                    output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
                } else {
                    output.push(value);
                    counter--;
                }
            } else {
                output.push(value);
            }
        }
        return output;
    }

    // UCS-2 helpers: encode an array of codepoints into a string
    function ucs2encode(array) {
        var output = '';
        for (var i = 0; i < array.length; i++) {
            var value = array[i];
            if (value > 0xFFFF) {
                value -= 0x10000;
                output += String.fromCharCode(value >>> 10 & 0x3FF | 0xD800);
                value = 0xDC00 | value & 0x3FF;
            }
            output += String.fromCharCode(value);
        }
        return output;
    }

    function basicToDigit(cp) {
        if (cp - 0x30 < 0x0A) return cp - 0x16; // 0-9 => 26-35
        if (cp - 0x41 < 0x1A) return cp - 0x41; // A-Z => 0-25
        if (cp - 0x61 < 0x1A) return cp - 0x61; // a-z => 0-25
        return BASE;
    }

    function digitToBasic(digit, flag) {
        return digit + 22 + 75 * (digit < 26 ? 1 : 0) - ((flag !== 0 ? 1 : 0) << 5);
    }

    function adapt(delta, numPoints, firstTime) {
        var k = 0;
        delta = firstTime ? Math.floor(delta / DAMP) : (delta >> 1);
        delta += Math.floor(delta / numPoints);
        while (delta > ((BASE - TMIN) * TMAX >> 1)) {
            delta = Math.floor(delta / (BASE - TMIN));
            k += BASE;
        }
        return Math.floor(k + (BASE - TMIN + 1) * delta / (delta + SKEW));
    }

    function encode(input) {
        if (typeof input === 'string') {
            input = ucs2decode(input);
        }

        var output = [];
        var inputLength = input.length;

        var n = INITIAL_N;
        var delta = 0;
        var bias = INITIAL_BIAS;

        // Handle basic code points
        for (var j = 0; j < inputLength; j++) {
            if (input[j] < 0x80) {
                output.push(String.fromCharCode(input[j]));
            }
        }

        var basicLength = output.length;
        var handledCPCount = basicLength;

        if (basicLength > 0) {
            output.push(DELIMITER);
        }

        // If all chars are basic, no delimiter needed at the end
        if (handledCPCount === inputLength) {
            // Remove the trailing delimiter we just added
            if (basicLength > 0) {
                output.pop();
            }
            return output.join('');
        }

        while (handledCPCount < inputLength) {
            var m = 0x7FFFFFFF; // maxint
            for (var i = 0; i < inputLength; i++) {
                if (input[i] >= n && input[i] < m) {
                    m = input[i];
                }
            }

            if (m - n > Math.floor((0x7FFFFFFF - delta) / (handledCPCount + 1))) {
                error('overflow');
            }

            delta += (m - n) * (handledCPCount + 1);
            n = m;

            for (var i = 0; i < inputLength; i++) {
                if (input[i] < n) {
                    if (++delta > 0x7FFFFFFF) {
                        error('overflow');
                    }
                }
                if (input[i] === n) {
                    var q = delta;
                    for (var k = BASE; /* no condition */; k += BASE) {
                        var t = k <= bias ? TMIN : (k >= bias + TMAX ? TMAX : k - bias);
                        if (q < t) break;
                        output.push(String.fromCharCode(digitToBasic(t + (q - t) % (BASE - t), 0)));
                        q = Math.floor((q - t) / (BASE - t));
                    }
                    output.push(String.fromCharCode(digitToBasic(q, 0)));
                    bias = adapt(delta, handledCPCount + 1, handledCPCount === basicLength);
                    delta = 0;
                    handledCPCount++;
                }
            }
            delta++;
            n++;
        }
        return output.join('');
    }

    function decode(input) {
        var output = [];
        var inputLength = input.length;

        // If there's no delimiter, there are no non-basic codepoints encoded.
        // The entire input is basic codepoints — return as-is.
        var basic = input.lastIndexOf(DELIMITER);
        if (basic < 0) {
            return input;
        }

        var n = INITIAL_N;
        var i = 0;
        var bias = INITIAL_BIAS;

        for (var j = 0; j < basic; j++) {
            if (input.charCodeAt(j) >= 0x80) {
                error('not-basic');
            }
            output.push(input.charCodeAt(j));
        }

        var index = basic > 0 ? basic + 1 : 0;

        while (index < inputLength) {
            var oldi = i;
            var w = 1;
            for (var k = BASE; /* no condition */; k += BASE) {
                if (index >= inputLength) error('invalid-input');
                var digit = basicToDigit(input.charCodeAt(index++));
                if (digit >= BASE || digit > Math.floor((0x7FFFFFFF - i) / w)) {
                    error('overflow');
                }
                i += digit * w;
                var t = k <= bias ? TMIN : (k >= bias + TMAX ? TMAX : k - bias);
                if (digit < t) break;
                if (w > Math.floor(0x7FFFFFFF / (BASE - t))) {
                    error('overflow');
                }
                w *= (BASE - t);
            }
            var out = output.length + 1;
            bias = adapt(i - oldi, out, oldi === 0);
            if (Math.floor(i / out) > 0x7FFFFFFF - n) {
                error('overflow');
            }
            n += Math.floor(i / out);
            i %= out;
            output.splice(i++, 0, n);
        }

        return ucs2encode(output);
    }

    function toASCII(domain) {
        var labels = domain.split('.');
        var encoded = [];
        for (var i = 0; i < labels.length; i++) {
            var label = labels[i];
            var hasNonASCII = false;
            for (var j = 0; j < label.length; j++) {
                if (label.charCodeAt(j) >= 0x80) {
                    hasNonASCII = true;
                    break;
                }
            }
            if (hasNonASCII) {
                encoded.push('xn--' + encode(label));
            } else {
                encoded.push(label);
            }
        }
        return encoded.join('.');
    }

    function toUnicode(domain) {
        var labels = domain.split('.');
        var decoded = [];
        for (var i = 0; i < labels.length; i++) {
            var label = labels[i];
            if (label.indexOf('xn--') === 0) {
                decoded.push(decode(label.slice(4)));
            } else {
                decoded.push(label);
            }
        }
        return decoded.join('.');
    }

    var module = {
        version: '2.3.1',
        ucs2: {
            decode: ucs2decode,
            encode: ucs2encode
        },
        decode: decode,
        encode: encode,
        toASCII: toASCII,
        toUnicode: toUnicode
    };
    module.default = module;

    globalThis.__tsxBuiltinModules.set('punycode', module);
    globalThis.__tsxBuiltinModules.set('node:punycode', module);
    globalThis.__tsxBuiltinModules.set('punycode/', module);
    globalThis.__tsxBuiltinModules.set('punycode/punycode', module);
})();
