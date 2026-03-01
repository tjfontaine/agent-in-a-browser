// assert.js - Node.js assert module compatible subset

(function () {
    function AssertionError(message, actual, expected, operator) {
        this.name = 'AssertionError';
        this.message = message || 'Assertion failed';
        this.actual = actual;
        this.expected = expected;
        this.operator = operator || '==';
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, AssertionError);
        }
    }
    AssertionError.prototype = Object.create(Error.prototype);
    AssertionError.prototype.constructor = AssertionError;

    function formatValue(v) {
        if (typeof globalThis.__tsxBuiltinModules !== 'undefined') {
            var util = globalThis.__tsxBuiltinModules.get('util');
            if (util && util.inspect) return util.inspect(v);
        }
        try { return JSON.stringify(v); }
        catch (_) { return String(v); }
    }

    function assert(value, message) {
        if (!value) {
            throw new AssertionError(
                message || 'Expected truthy value, got ' + formatValue(value),
                value, true, '=='
            );
        }
    }

    assert.ok = assert;

    assert.strictEqual = function (actual, expected, message) {
        if (actual !== expected) {
            throw new AssertionError(
                message || 'Expected ' + formatValue(actual) + ' === ' + formatValue(expected),
                actual, expected, '==='
            );
        }
    };

    assert.notStrictEqual = function (actual, expected, message) {
        if (actual === expected) {
            throw new AssertionError(
                message || 'Expected ' + formatValue(actual) + ' !== ' + formatValue(expected),
                actual, expected, '!=='
            );
        }
    };

    function deepEqual(a, b) {
        if (a === b) return true;
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
        if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
        if (a instanceof RegExp && b instanceof RegExp) return a.toString() === b.toString();

        var keysA = Object.keys(a);
        var keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;

        for (var i = 0; i < keysA.length; i++) {
            if (!Object.prototype.hasOwnProperty.call(b, keysA[i])) return false;
            if (!deepEqual(a[keysA[i]], b[keysA[i]])) return false;
        }

        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
        }

        return true;
    }

    assert.deepStrictEqual = function (actual, expected, message) {
        if (!deepEqual(actual, expected)) {
            throw new AssertionError(
                message || 'Expected deep equality.\n  actual: ' + formatValue(actual) + '\n  expected: ' + formatValue(expected),
                actual, expected, 'deepStrictEqual'
            );
        }
    };

    assert.notDeepStrictEqual = function (actual, expected, message) {
        if (deepEqual(actual, expected)) {
            throw new AssertionError(
                message || 'Expected not deep equality',
                actual, expected, 'notDeepStrictEqual'
            );
        }
    };

    assert.throws = function (fn, expected, message) {
        var threw = false;
        try { fn(); }
        catch (e) { threw = true; }
        if (!threw) {
            throw new AssertionError(
                message || 'Expected function to throw',
                undefined, undefined, 'throws'
            );
        }
    };

    assert.doesNotThrow = function (fn, expected, message) {
        try { fn(); }
        catch (e) {
            throw new AssertionError(
                message || 'Expected function not to throw, but it threw: ' + e.message,
                e, undefined, 'doesNotThrow'
            );
        }
    };

    assert.fail = function (message) {
        throw new AssertionError(
            typeof message === 'string' ? message : 'Failed',
            undefined, undefined, 'fail'
        );
    };

    assert.AssertionError = AssertionError;

    globalThis.__tsxBuiltinModules.set('assert', assert);
    globalThis.__tsxBuiltinModules.set('node:assert', assert);
})();
