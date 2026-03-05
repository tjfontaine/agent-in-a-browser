// child_process.js - Node.js child_process module compatible subset
// Uses __tsxShellExec__ bridge for shell command execution

(function () {
    var hasShellExec = typeof globalThis.__tsxShellExec__ === 'function';

    function parseExecResult(jsonStr) {
        try {
            return JSON.parse(jsonStr);
        } catch (e) {
            return { code: 1, stdout: '', stderr: 'Failed to parse shell result' };
        }
    }

    // --- execSync ---
    function execSync(command, options) {
        if (!hasShellExec) {
            throw new Error('child_process.execSync is not supported in WASM sandbox');
        }
        if (typeof command !== 'string' || command.length === 0) {
            throw new Error('child_process.execSync: command must be a non-empty string');
        }

        var opts = options || {};
        var cwd = opts.cwd || null;
        var envJson = opts.env ? JSON.stringify(opts.env) : null;
        var stdinData = opts.input != null ? String(opts.input) : null;

        var resultJson = globalThis.__tsxShellExec__(command, cwd, envJson, stdinData);
        var result = parseExecResult(resultJson);

        if (result.code !== 0) {
            var err = new Error('Command failed: ' + command + '\n' + result.stderr);
            err.status = result.code;
            err.code = result.code;
            err.stdout = opts.encoding ? result.stdout : Buffer.from(result.stdout);
            err.stderr = opts.encoding ? result.stderr : Buffer.from(result.stderr);
            throw err;
        }

        if (opts.encoding) {
            return result.stdout;
        }
        return Buffer.from(result.stdout);
    }

    // --- spawnSync ---
    function spawnSync(command, args, options) {
        if (!hasShellExec) {
            throw new Error('child_process.spawnSync is not supported in WASM sandbox');
        }

        var opts = options || {};
        var fullCmd;
        if (args && args.length > 0) {
            // Build command string from command + args
            var escapedArgs = args.map(function (a) {
                // Simple shell escaping
                if (/[^a-zA-Z0-9_\-\.\/=]/.test(a)) {
                    return "'" + a.replace(/'/g, "'\\''") + "'";
                }
                return a;
            });
            fullCmd = command + ' ' + escapedArgs.join(' ');
        } else {
            fullCmd = command;
        }

        // If shell option is false and we have a direct command, still use shell
        var cwd = opts.cwd || null;
        var envJson = opts.env ? JSON.stringify(opts.env) : null;
        var stdinData = opts.input != null ? String(opts.input) : null;

        var resultJson = globalThis.__tsxShellExec__(fullCmd, cwd, envJson, stdinData);
        var result = parseExecResult(resultJson);

        var encoding = opts.encoding || null;

        return {
            status: result.code,
            stdout: encoding ? result.stdout : Buffer.from(result.stdout),
            stderr: encoding ? result.stderr : Buffer.from(result.stderr),
            signal: null,
            pid: 0,
            output: [null, encoding ? result.stdout : Buffer.from(result.stdout), encoding ? result.stderr : Buffer.from(result.stderr)],
            error: null
        };
    }

    // --- exec ---
    function exec(command, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        if (!hasShellExec) {
            var err = new Error('child_process.exec is not supported in WASM sandbox');
            if (typeof callback === 'function') {
                callback(err, '', '');
            }
            return;
        }

        var opts = options || {};
        var cwd = opts.cwd || null;
        var envJson = opts.env ? JSON.stringify(opts.env) : null;

        // Execute synchronously but deliver via callback (QuickJS is single-threaded)
        try {
            var resultJson = globalThis.__tsxShellExec__(command, cwd, envJson, null);
            var result = parseExecResult(resultJson);

            if (result.code !== 0) {
                var error = new Error('Command failed: ' + command);
                error.code = result.code;
                if (typeof callback === 'function') {
                    callback(error, result.stdout, result.stderr);
                }
            } else {
                if (typeof callback === 'function') {
                    callback(null, result.stdout, result.stderr);
                }
            }
        } catch (e) {
            if (typeof callback === 'function') {
                callback(e, '', '');
            }
        }
    }

    // --- execFile ---
    function execFile(file, args, options, callback) {
        if (typeof args === 'function') {
            callback = args;
            args = [];
            options = {};
        } else if (typeof options === 'function') {
            callback = options;
            options = {};
        }

        var cmd = file;
        if (args && args.length > 0) {
            cmd += ' ' + args.join(' ');
        }
        exec(cmd, options, callback);
    }

    // --- execFileSync ---
    function execFileSync(file, args, options) {
        var cmd = file;
        if (args && args.length > 0) {
            cmd += ' ' + args.join(' ');
        }
        return execSync(cmd, options);
    }

    // --- spawn (limited sync implementation) ---
    function spawn(command, args, options) {
        if (!hasShellExec) {
            throw new Error('child_process.spawn is not supported in WASM sandbox');
        }

        // Return a minimal ChildProcess-like object
        var result = spawnSync(command, args, options);
        var EventEmitter = globalThis.__tsxBuiltinModules.get('events');
        var cp = new EventEmitter();
        cp.pid = 0;
        cp.exitCode = result.status;
        cp.stdout = new EventEmitter();
        cp.stderr = new EventEmitter();

        // Emit events synchronously
        if (result.stdout) cp.stdout.emit('data', result.stdout);
        cp.stdout.emit('end');
        if (result.stderr) cp.stderr.emit('data', result.stderr);
        cp.stderr.emit('end');
        cp.emit('close', result.status);

        return cp;
    }

    // --- fork (still not supported) ---
    function fork() {
        throw new Error('child_process.fork is not supported in WASM sandbox');
    }

    var module = {
        exec: exec,
        execSync: execSync,
        execFile: execFile,
        execFileSync: execFileSync,
        spawn: spawn,
        spawnSync: spawnSync,
        fork: fork,
    };

    globalThis.__tsxBuiltinModules.set('child_process', module);
    globalThis.__tsxBuiltinModules.set('node:child_process', module);
})();
