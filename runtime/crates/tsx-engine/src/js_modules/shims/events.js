// events.js - Node.js EventEmitter compatible implementation

(function () {
    function EventEmitter() {
        this._events = Object.create(null);
        this._maxListeners = EventEmitter.defaultMaxListeners;
    }

    EventEmitter.defaultMaxListeners = 10;

    EventEmitter.prototype.on = function (event, listener) {
        if (!this._events[event]) this._events[event] = [];
        this._events[event].push({ fn: listener, once: false });
        return this;
    };

    EventEmitter.prototype.addListener = EventEmitter.prototype.on;

    EventEmitter.prototype.once = function (event, listener) {
        if (!this._events[event]) this._events[event] = [];
        this._events[event].push({ fn: listener, once: true });
        return this;
    };

    EventEmitter.prototype.off = function (event, listener) {
        const arr = this._events[event];
        if (!arr) return this;
        this._events[event] = arr.filter(function (entry) { return entry.fn !== listener; });
        if (this._events[event].length === 0) delete this._events[event];
        return this;
    };

    EventEmitter.prototype.removeListener = EventEmitter.prototype.off;

    EventEmitter.prototype.removeAllListeners = function (event) {
        if (event === undefined) {
            this._events = Object.create(null);
        } else {
            delete this._events[event];
        }
        return this;
    };

    EventEmitter.prototype.emit = function (event) {
        var args = [];
        for (var i = 1; i < arguments.length; i++) args.push(arguments[i]);

        if (event === 'error' && !this._events.error) {
            var err = args[0];
            if (err instanceof Error) throw err;
            throw new Error('Unhandled error event: ' + err);
        }

        var arr = this._events[event];
        if (!arr || arr.length === 0) return false;

        // Copy so removals during emit don't skip entries
        var copy = arr.slice();
        for (var j = 0; j < copy.length; j++) {
            if (copy[j].once) {
                this.off(event, copy[j].fn);
            }
            copy[j].fn.apply(this, args);
        }
        return true;
    };

    EventEmitter.prototype.listenerCount = function (event) {
        var arr = this._events[event];
        return arr ? arr.length : 0;
    };

    EventEmitter.prototype.listeners = function (event) {
        var arr = this._events[event];
        if (!arr) return [];
        return arr.map(function (entry) { return entry.fn; });
    };

    EventEmitter.prototype.eventNames = function () {
        return Object.keys(this._events);
    };

    EventEmitter.prototype.setMaxListeners = function (n) {
        this._maxListeners = n;
        return this;
    };

    EventEmitter.prototype.getMaxListeners = function () {
        return this._maxListeners;
    };

    // Module exports — default export is EventEmitter itself (Node.js compat)
    var eventsModule = EventEmitter;
    eventsModule.EventEmitter = EventEmitter;

    globalThis.__tsxBuiltinModules.set('events', eventsModule);
    globalThis.__tsxBuiltinModules.set('node:events', eventsModule);
})();
