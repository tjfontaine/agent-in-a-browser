// module.js - Node.js Module system internals

(function () {
    function Module(id) {
        this.id = id || '';
        this.path = '';
        this.exports = {};
        this.filename = null;
        this.loaded = false;
        this.children = [];
        this.paths = [];
    }

    Module.createRequire = function (filename) {
        return globalThis.require;
    };

    Object.defineProperty(Module, 'builtinModules', {
        get: function () {
            var result = [];
            var seen = {};
            globalThis.__tsxBuiltinModules.forEach(function (value, key) {
                if (key.indexOf('node:') !== 0 && !seen[key]) {
                    seen[key] = true;
                    result.push(key);
                }
            });
            return result;
        },
        enumerable: true,
        configurable: true
    });

    Module.isBuiltin = function (moduleName) {
        if (globalThis.__tsxBuiltinModules.has(moduleName)) return true;
        if (moduleName.indexOf('node:') !== 0 && globalThis.__tsxBuiltinModules.has('node:' + moduleName)) return true;
        if (moduleName.indexOf('node:') === 0 && globalThis.__tsxBuiltinModules.has(moduleName.slice(5))) return true;
        return false;
    };

    Module._resolveFilename = function (request) {
        return request;
    };

    Module._cache = {};

    Module._extensions = {
        '.js': function () {},
        '.json': function () {},
        '.node': function () {}
    };

    globalThis.__tsxBuiltinModules.set('module', Module);
    globalThis.__tsxBuiltinModules.set('node:module', Module);
})();
