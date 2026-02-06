// process.js - Additional process functionality
// Core process object is created in Rust, this adds methods

if (!globalThis.__tsxRequireCache) {
    globalThis.__tsxRequireCache = new Map();
}
if (!globalThis.__tsxRequireBaseStack) {
    globalThis.__tsxRequireBaseStack = [];
}

function __tsxCurrentRequireBase() {
    const stack = globalThis.__tsxRequireBaseStack;
    if (stack.length > 0) return stack[stack.length - 1];
    if (globalThis.__tsxEntryBase) return globalThis.__tsxEntryBase;
    return '/';
}

function __tsxDirname(path) {
    if (!path || path === '/') return '/';
    const normalized = String(path).replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return '/';
    return normalized.slice(0, idx);
}

function __tsxCreateRequire(basePath) {
    return function require(specifier) {
        const base = basePath || __tsxCurrentRequireBase();
        const resolved = __tsxRequireResolve__(String(base), String(specifier));
        if (globalThis.__tsxRequireCache.has(resolved)) {
            return globalThis.__tsxRequireCache.get(resolved);
        }

        const payload = JSON.parse(__tsxRequireLoad__(resolved));
        if (!payload.ok) {
            throw new Error(payload.error || `Failed to load module: ${specifier}`);
        }

        if (payload.format === 'esm') {
            throw new Error(`Cannot require() ESM module: ${resolved}`);
        }

        if (payload.format === 'json') {
            const jsonValue = JSON.parse(payload.source || 'null');
            globalThis.__tsxRequireCache.set(resolved, jsonValue);
            return jsonValue;
        }

        const module = { exports: {} };
        globalThis.__tsxRequireCache.set(resolved, module.exports);

        const localRequire = __tsxCreateRequire(payload.path);
        const __filename = payload.path;
        const __dirname = __tsxDirname(payload.path);

        globalThis.__tsxRequireBaseStack.push(payload.path);
        try {
            const wrapped = new Function(
                'exports',
                'require',
                'module',
                '__filename',
                '__dirname',
                payload.source || ''
            );
            wrapped(module.exports, localRequire, module, __filename, __dirname);
        } finally {
            globalThis.__tsxRequireBaseStack.pop();
        }

        globalThis.__tsxRequireCache.set(resolved, module.exports);
        return module.exports;
    };
}

globalThis.__tsxCreateRequire = __tsxCreateRequire;
globalThis.require = __tsxCreateRequire(globalThis.__tsxEntryBase || '/');

// process.exit(code) - exit with code
globalThis.process.exit = function (code) {
    // In WASM context, we can't really exit, but we can throw
    throw new Error(`process.exit(${code || 0})`);
};

function __tsxNormalizePath(path) {
    const normalized = String(path).replace(/\\/g, '/');
    const absolute = normalized.startsWith('/');
    const parts = normalized.split('/');
    const out = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (out.length > 0) out.pop();
            continue;
        }
        out.push(part);
    }
    return absolute ? `/${out.join('/')}` || '/' : out.join('/');
}

function __tsxResolvePath(base, nextPath) {
    const candidate = String(nextPath);
    if (candidate.startsWith('/')) return __tsxNormalizePath(candidate);
    return __tsxNormalizePath(`${base || '/'}${(base || '/').endsWith('/') ? '' : '/'}${candidate}`);
}

let __tsxProcessCwd =
    typeof globalThis.__tsxProcessGetCwd__ === 'function'
        ? String(globalThis.__tsxProcessGetCwd__() || '/')
        : '/';
__tsxProcessCwd = __tsxNormalizePath(__tsxProcessCwd);

// process.cwd() - return current working directory
globalThis.process.cwd = function () {
    return __tsxProcessCwd;
};

// process.chdir(path) - change current working directory
globalThis.process.chdir = function (nextPath) {
    if (nextPath === undefined || nextPath === null || nextPath === '') {
        throw new TypeError('process.chdir() requires a non-empty path');
    }
    __tsxProcessCwd = __tsxResolvePath(__tsxProcessCwd, String(nextPath));
    if (typeof globalThis.__tsxProcessSetCwd__ === 'function') {
        globalThis.__tsxProcessSetCwd__(__tsxProcessCwd);
    }
};

// process.hrtime() - high resolution time (stub)
globalThis.process.hrtime = function (prev) {
    const now = Date.now();
    if (prev) {
        const diff = now - (prev[0] * 1000 + prev[1] / 1e6);
        return [Math.floor(diff / 1000), (diff % 1000) * 1e6];
    }
    return [Math.floor(now / 1000), (now % 1000) * 1e6];
};

// process.nextTick(callback) - execute on next tick
globalThis.process.nextTick = function (callback, ...args) {
    Promise.resolve().then(() => callback(...args));
};

let __tsxTimerId = 1;
const __tsxTimers = new Map();

globalThis.setTimeout = function (callback, _ms = 0, ...args) {
    const id = __tsxTimerId++;
    __tsxTimers.set(id, { active: true });
    Promise.resolve().then(() => {
        const t = __tsxTimers.get(id);
        if (!t || !t.active) return;
        callback(...args);
        __tsxTimers.delete(id);
    });
    return id;
};

globalThis.clearTimeout = function (id) {
    const timer = __tsxTimers.get(id);
    if (timer) timer.active = false;
    __tsxTimers.delete(id);
};

globalThis.setImmediate = function (callback, ...args) {
    return globalThis.setTimeout(callback, 0, ...args);
};

globalThis.clearImmediate = function (id) {
    globalThis.clearTimeout(id);
};

globalThis.setInterval = function (callback, _ms = 0, ...args) {
    const id = __tsxTimerId++;
    __tsxTimers.set(id, { active: true, interval: true });
    const tick = () => {
        const t = __tsxTimers.get(id);
        if (!t || !t.active) return;
        callback(...args);
        Promise.resolve().then(tick);
    };
    Promise.resolve().then(tick);
    return id;
};

globalThis.clearInterval = function (id) {
    globalThis.clearTimeout(id);
};

globalThis.__filename = globalThis.__tsxEntryBase || '';
globalThis.__dirname = __tsxDirname(globalThis.__tsxEntryBase || '/');

// process.stdout/stderr stubs
globalThis.process.stdout = {
    write: function (str) {
        // Use console.log but strip trailing newline if present
        const output = String(str).replace(/\n$/, '');
        if (output) console.log(output);
        return true;
    },
    isTTY: false
};

globalThis.process.stderr = {
    write: function (str) {
        const output = String(str).replace(/\n$/, '');
        if (output) console.error(output);
        return true;
    },
    isTTY: false
};


// Track unhandled rejections - this helps surface async errors
globalThis.__lastUnhandledError = null;

// Install unhandled rejection handler
// QuickJS doesn't have addEventListener, but we can override Promise behavior
const OriginalPromise = globalThis.Promise;
const originalThen = OriginalPromise.prototype.then;

// Wrap Promise.then to catch unhandled rejections
OriginalPromise.prototype.then = function (onFulfilled, onRejected) {
    const wrappedRejected = onRejected ? function (error) {
        globalThis.__lastUnhandledError = error;
        console.error('[UnhandledRejection]', error?.message || String(error));
        return onRejected(error);
    } : undefined;

    return originalThen.call(this, onFulfilled, wrappedRejected);
};
