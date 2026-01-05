// process.js - Additional process functionality
// Core process object is created in Rust, this adds methods

// process.exit(code) - exit with code
globalThis.process.exit = function (code) {
    // In WASM context, we can't really exit, but we can throw
    throw new Error(`process.exit(${code || 0})`);
};

// process.cwd() - return current working directory
globalThis.process.cwd = function () {
    return '/';
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
