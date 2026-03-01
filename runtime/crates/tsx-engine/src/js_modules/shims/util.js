// util.js - Node.js util module compatible subset

(function () {
    function format(fmt) {
        if (typeof fmt !== 'string') {
            var parts = [];
            for (var i = 0; i < arguments.length; i++) parts.push(inspect(arguments[i]));
            return parts.join(' ');
        }

        var args = [];
        for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);

        var argIdx = 0;
        var result = fmt.replace(/%[sdjoO%]/g, function (match) {
            if (match === '%%') return '%';
            if (argIdx >= args.length) return match;
            var val = args[argIdx++];
            switch (match) {
                case '%s': return String(val);
                case '%d': return Number(val).toString();
                case '%j':
                    try { return JSON.stringify(val); }
                    catch (_) { return '[Circular]'; }
                case '%o':
                case '%O':
                    return inspect(val);
                default: return match;
            }
        });

        // Append remaining args
        while (argIdx < args.length) {
            result += ' ' + (args[argIdx] === null ? 'null' : typeof args[argIdx] === 'object' ? inspect(args[argIdx]) : String(args[argIdx]));
            argIdx++;
        }
        return result;
    }

    function inspect(obj, opts) {
        if (obj === null) return 'null';
        if (obj === undefined) return 'undefined';
        if (typeof obj === 'string') return "'" + obj + "'";
        if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
        if (typeof obj === 'function') return '[Function: ' + (obj.name || 'anonymous') + ']';
        if (obj instanceof Date) return obj.toISOString();
        if (obj instanceof RegExp) return obj.toString();
        if (Array.isArray(obj)) {
            var items = [];
            for (var i = 0; i < obj.length; i++) items.push(inspect(obj[i]));
            return '[ ' + items.join(', ') + ' ]';
        }
        if (typeof obj === 'object') {
            var keys = Object.keys(obj);
            var pairs = [];
            for (var k = 0; k < keys.length; k++) {
                pairs.push(keys[k] + ': ' + inspect(obj[keys[k]]));
            }
            return '{ ' + pairs.join(', ') + ' }';
        }
        return String(obj);
    }

    function promisify(original) {
        return function () {
            var args = [];
            for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
            return new Promise(function (resolve, reject) {
                args.push(function (err, val) {
                    if (err) reject(err);
                    else resolve(val);
                });
                original.apply(null, args);
            });
        };
    }

    function inherits(ctor, superCtor) {
        ctor.super_ = superCtor;
        ctor.prototype = Object.create(superCtor.prototype, {
            constructor: { value: ctor, enumerable: false, writable: true, configurable: true }
        });
    }

    function deprecate(fn, msg) {
        var warned = false;
        return function () {
            if (!warned) {
                warned = true;
                console.warn('DeprecationWarning: ' + msg);
            }
            return fn.apply(this, arguments);
        };
    }

    var types = {
        isDate: function (v) { return v instanceof Date; },
        isRegExp: function (v) { return v instanceof RegExp; },
        isPromise: function (v) { return v instanceof Promise; },
        isMap: function (v) { return v instanceof Map; },
        isSet: function (v) { return v instanceof Set; },
        isTypedArray: function (v) {
            return v instanceof Int8Array || v instanceof Uint8Array || v instanceof Uint8ClampedArray ||
                v instanceof Int16Array || v instanceof Uint16Array || v instanceof Int32Array ||
                v instanceof Uint32Array || v instanceof Float32Array || v instanceof Float64Array;
        },
        isArrayBuffer: function (v) { return v instanceof ArrayBuffer; },
        isArrayBufferView: function (v) { return ArrayBuffer.isView(v); },
    };

    var utilModule = {
        format: format,
        inspect: inspect,
        promisify: promisify,
        inherits: inherits,
        deprecate: deprecate,
        types: types,
    };

    globalThis.__tsxBuiltinModules.set('util', utilModule);
    globalThis.__tsxBuiltinModules.set('node:util', utilModule);
})();
