// Node.js querystring module shim
// Embedded via include_str! for IDE linting support

(function() {
    function escape(str) {
        return encodeURIComponent(str);
    }

    function unescape(str) {
        return decodeURIComponent(str);
    }

    function stringify(obj, sep, eq) {
        if (!obj || typeof obj !== 'object') return '';
        sep = sep || '&';
        eq = eq || '=';
        var parts = [];
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var value = obj[key];
            if (Array.isArray(value)) {
                for (var j = 0; j < value.length; j++) {
                    parts.push(escape(String(key)) + eq + escape(String(value[j])));
                }
            } else {
                parts.push(escape(String(key)) + eq + escape(String(value)));
            }
        }
        return parts.join(sep);
    }

    function parse(str, sep, eq, options) {
        if (typeof str !== 'string') return {};
        sep = sep || '&';
        eq = eq || '=';
        var maxKeys = (options && typeof options.maxKeys === 'number') ? options.maxKeys : 1000;
        var obj = {};
        var pairs = str.split(sep);
        var len = maxKeys > 0 ? Math.min(pairs.length, maxKeys) : pairs.length;
        for (var i = 0; i < len; i++) {
            var pair = pairs[i];
            if (!pair) continue;
            var idx = pair.indexOf(eq);
            var key, value;
            if (idx === -1) {
                key = unescape(pair);
                value = '';
            } else {
                key = unescape(pair.slice(0, idx));
                value = unescape(pair.slice(idx + eq.length));
            }
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                if (Array.isArray(obj[key])) {
                    obj[key].push(value);
                } else {
                    obj[key] = [obj[key], value];
                }
            } else {
                obj[key] = value;
            }
        }
        return obj;
    }

    var module = {
        stringify: stringify,
        parse: parse,
        escape: escape,
        unescape: unescape,
        encode: stringify,
        decode: parse
    };
    module.default = module;

    globalThis.__tsxBuiltinModules.set('querystring', module);
    globalThis.__tsxBuiltinModules.set('node:querystring', module);
})();
