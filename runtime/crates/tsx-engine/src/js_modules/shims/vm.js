// vm.js - Node.js vm module compatible subset for WASM sandbox
// Provides Script class and code evaluation using Function constructor.

(function () {
    function Script(code, options) {
        this._code = String(code || '');
        this._options = options || {};
    }

    Script.prototype.runInThisContext = function (options) {
        return (new Function(this._code))();
    };

    Script.prototype.runInNewContext = function (sandbox, options) {
        var ctx = sandbox || {};
        var keys = Object.keys(ctx);
        var values = [];
        for (var i = 0; i < keys.length; i++) {
            values.push(ctx[keys[i]]);
        }
        var fn = new Function(keys, this._code);
        return fn.apply(undefined, values);
    };

    Script.prototype.createCachedData = function () {
        return {};
    };

    function createScript(code, options) {
        return new Script(code, options);
    }

    function runInThisContext(code, options) {
        var script = new Script(code, options);
        return script.runInThisContext(options);
    }

    function runInNewContext(code, sandbox, options) {
        var script = new Script(code, options);
        return script.runInNewContext(sandbox, options);
    }

    function createContext(sandbox) {
        return sandbox || {};
    }

    function isContext(obj) {
        return typeof obj === 'object' && obj !== null;
    }

    function compileFunction(code, params, options) {
        params = params || [];
        return new Function(params, code);
    }

    var vmModule = {
        Script: Script,
        createScript: createScript,
        runInThisContext: runInThisContext,
        runInNewContext: runInNewContext,
        createContext: createContext,
        isContext: isContext,
        compileFunction: compileFunction,
    };

    globalThis.__tsxBuiltinModules.set('vm', vmModule);
    globalThis.__tsxBuiltinModules.set('node:vm', vmModule);
})();
