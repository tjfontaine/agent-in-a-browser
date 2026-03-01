// domain.js - Deprecated Node.js domain module stub
// Domains are deprecated but some packages still import them.

(function () {
    var EventEmitter = globalThis.__tsxBuiltinModules.get('events');

    function Domain() {
        EventEmitter.call(this);
        this.members = [];
    }
    Domain.prototype = Object.create(EventEmitter.prototype);
    Domain.prototype.constructor = Domain;

    Domain.prototype.add = function (emitter) {
        this.members.push(emitter);
    };

    Domain.prototype.remove = function (emitter) {
        var filtered = [];
        for (var i = 0; i < this.members.length; i++) {
            if (this.members[i] !== emitter) {
                filtered.push(this.members[i]);
            }
        }
        this.members = filtered;
    };

    Domain.prototype.bind = function (cb) {
        var self = this;
        return function () {
            try {
                return cb.apply(this, arguments);
            } catch (err) {
                self.emit('error', err);
            }
        };
    };

    Domain.prototype.intercept = function (cb) {
        var self = this;
        return function (err) {
            if (err) {
                self.emit('error', err);
                return;
            }
            var args = [];
            for (var i = 1; i < arguments.length; i++) {
                args.push(arguments[i]);
            }
            try {
                return cb.apply(this, args);
            } catch (e) {
                self.emit('error', e);
            }
        };
    };

    Domain.prototype.run = function (fn) {
        try {
            return fn();
        } catch (err) {
            this.emit('error', err);
        }
    };

    Domain.prototype.dispose = function () {
        this.emit('dispose');
        this.members = [];
        this.removeAllListeners();
    };

    Domain.prototype.enter = function () {
        // no-op: sets the active domain in Node.js
    };

    Domain.prototype.exit = function () {
        // no-op: unsets the active domain in Node.js
    };

    var module = {
        create: function () {
            return new Domain();
        },
        Domain: Domain,
        active: null
    };

    globalThis.__tsxBuiltinModules.set('domain', module);
    globalThis.__tsxBuiltinModules.set('node:domain', module);
})();
