// timers.js - Node.js timers module
// Re-exports the timer globals already defined in process.js
// Also provides timers/promises with promisified versions.

(function() {
    var module = {
        setTimeout: globalThis.setTimeout,
        setInterval: globalThis.setInterval,
        setImmediate: globalThis.setImmediate,
        clearTimeout: globalThis.clearTimeout,
        clearInterval: globalThis.clearInterval,
        clearImmediate: globalThis.clearImmediate
    };

    globalThis.__tsxBuiltinModules.set('timers', module);
    globalThis.__tsxBuiltinModules.set('node:timers', module);

    // timers/promises - promisified timer functions
    var promises = {
        setTimeout: function(delay, value) {
            return new Promise(function(resolve) {
                globalThis.setTimeout(function() { resolve(value); }, delay || 0);
            });
        },
        setImmediate: function(value) {
            return new Promise(function(resolve) {
                globalThis.setImmediate(function() { resolve(value); });
            });
        },
        setInterval: function(delay, value) {
            // Returns an async iterable that yields value on each interval tick.
            // Simplified stub: returns an object with a Symbol.asyncIterator.
            var active = true;
            return {
                [Symbol.asyncIterator]: function() {
                    return {
                        next: function() {
                            if (!active) return Promise.resolve({ done: true, value: undefined });
                            return new Promise(function(resolve) {
                                globalThis.setTimeout(function() {
                                    resolve({ done: false, value: value });
                                }, delay || 0);
                            });
                        },
                        return: function() {
                            active = false;
                            return Promise.resolve({ done: true, value: undefined });
                        }
                    };
                }
            };
        }
    };

    globalThis.__tsxBuiltinModules.set('timers/promises', promises);
    globalThis.__tsxBuiltinModules.set('node:timers/promises', promises);
})();
