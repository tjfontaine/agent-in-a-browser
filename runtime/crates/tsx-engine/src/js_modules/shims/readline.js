// readline.js - Node.js readline module stub for WASM sandbox
// Interactive readline is limited in WASM; provides the basic interface.

(function () {
    var EventEmitter = globalThis.__tsxBuiltinModules.get('events');
    if (!EventEmitter) throw new Error('readline module requires events module to be loaded first');

    // --- Interface ---
    function Interface(input, output, completer, terminal) {
        EventEmitter.call(this);
        this._input = input || null;
        this._output = output || null;
        this._completer = completer || null;
        this._terminal = terminal || false;
        this._prompt = '> ';
    }
    Interface.prototype = Object.create(EventEmitter.prototype);
    Interface.prototype.constructor = Interface;

    Interface.prototype.question = function (query, options, cb) {
        if (typeof cb === 'function') {
            cb('');
        } else if (typeof options === 'function') {
            options('');
        }
    };

    Interface.prototype.close = function () {
        this.emit('close');
    };

    Interface.prototype.pause = function () {
        this.emit('pause');
        return this;
    };

    Interface.prototype.resume = function () {
        this.emit('resume');
        return this;
    };

    Interface.prototype.write = function (data) {
        // no-op in WASM sandbox
    };

    Interface.prototype.setPrompt = function (prompt) {
        this._prompt = prompt;
    };

    Interface.prototype.getPrompt = function () {
        return this._prompt;
    };

    Interface.prototype.prompt = function (preserveCursor) {
        // no-op in WASM sandbox
    };

    // --- Factory ---
    function createInterface(options) {
        if (options && typeof options === 'object' && !options.input && !options.output) {
            return new Interface(options.input, options.output, options.completer, options.terminal);
        }
        if (arguments.length > 1) {
            return new Interface(arguments[0], arguments[1], arguments[2], arguments[3]);
        }
        if (options && typeof options === 'object') {
            return new Interface(options.input, options.output, options.completer, options.terminal);
        }
        return new Interface(options);
    }

    // --- Utility functions ---
    function clearLine(stream, dir, cb) {
        if (typeof cb === 'function') cb();
    }

    function clearScreenDown(stream, cb) {
        if (typeof cb === 'function') cb();
    }

    function cursorTo(stream, x, y, cb) {
        if (typeof y === 'function') {
            y();
        } else if (typeof cb === 'function') {
            cb();
        }
    }

    function moveCursor(stream, dx, dy, cb) {
        if (typeof cb === 'function') cb();
    }

    function emitKeypressEvents(stream) {
        // no-op in WASM sandbox
    }

    // --- Module exports ---
    var readlineModule = {
        createInterface: createInterface,
        Interface: Interface,
        clearLine: clearLine,
        clearScreenDown: clearScreenDown,
        cursorTo: cursorTo,
        moveCursor: moveCursor,
        emitKeypressEvents: emitKeypressEvents
    };

    globalThis.__tsxBuiltinModules.set('readline', readlineModule);
    globalThis.__tsxBuiltinModules.set('node:readline', readlineModule);

    // --- readline/promises ---
    // Promisified version where question returns a Promise.
    function PromiseInterface(input, output, completer, terminal) {
        Interface.call(this, input, output, completer, terminal);
    }
    PromiseInterface.prototype = Object.create(Interface.prototype);
    PromiseInterface.prototype.constructor = PromiseInterface;

    PromiseInterface.prototype.question = function (query, options) {
        return Promise.resolve('');
    };

    function createPromiseInterface(options) {
        if (options && typeof options === 'object') {
            return new PromiseInterface(options.input, options.output, options.completer, options.terminal);
        }
        if (arguments.length > 1) {
            return new PromiseInterface(arguments[0], arguments[1], arguments[2], arguments[3]);
        }
        return new PromiseInterface(options);
    }

    var promisesModule = {
        createInterface: createPromiseInterface,
        Interface: PromiseInterface,
        clearLine: clearLine,
        clearScreenDown: clearScreenDown,
        cursorTo: cursorTo,
        moveCursor: moveCursor,
        emitKeypressEvents: emitKeypressEvents
    };

    globalThis.__tsxBuiltinModules.set('readline/promises', promisesModule);
    globalThis.__tsxBuiltinModules.set('node:readline/promises', promisesModule);
})();
