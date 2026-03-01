// child_process.js - Stub module for WASM sandbox
// All functions throw because process spawning is not available in WASM.

(function () {
    function notSupported(name) {
        return function () {
            throw new Error('child_process.' + name + ' is not supported in WASM sandbox');
        };
    }

    var module = {
        exec: notSupported('exec'),
        execSync: notSupported('execSync'),
        execFile: notSupported('execFile'),
        execFileSync: notSupported('execFileSync'),
        spawn: notSupported('spawn'),
        spawnSync: notSupported('spawnSync'),
        fork: notSupported('fork'),
    };

    globalThis.__tsxBuiltinModules.set('child_process', module);
    globalThis.__tsxBuiltinModules.set('node:child_process', module);
})();
