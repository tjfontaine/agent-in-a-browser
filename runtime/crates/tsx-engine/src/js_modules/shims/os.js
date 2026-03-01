// os.js - Node.js os module compatible subset

(function () {
    var osModule = {
        EOL: '\n',
        platform: function () { return 'wasi'; },
        arch: function () { return 'wasm32'; },
        type: function () { return 'WASI'; },
        release: function () { return '0.0.0'; },
        hostname: function () { return 'localhost'; },
        homedir: function () {
            return (globalThis.process && globalThis.process.env && globalThis.process.env.HOME) || '/home/user';
        },
        tmpdir: function () { return '/tmp'; },
        cpus: function () { return [{ model: 'wasm', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }]; },
        totalmem: function () { return 268435456; },
        freemem: function () { return 134217728; },
        uptime: function () { return 0; },
        loadavg: function () { return [0, 0, 0]; },
        networkInterfaces: function () { return {}; },
        userInfo: function () {
            return {
                uid: 0,
                gid: 0,
                username: 'wasm',
                homedir: osModule.homedir(),
                shell: '/bin/sh'
            };
        },
        endianness: function () { return 'LE'; },
    };

    globalThis.__tsxBuiltinModules.set('os', osModule);
    globalThis.__tsxBuiltinModules.set('node:os', osModule);
})();
