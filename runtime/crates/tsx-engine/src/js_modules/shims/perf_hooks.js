// perf_hooks.js - Node.js perf_hooks module compatible subset

(function () {
    var _timeOrigin = Date.now();
    var _entries = [];

    function PerformanceEntry(name, entryType, startTime, duration) {
        this.name = name;
        this.entryType = entryType;
        this.startTime = startTime;
        this.duration = duration;
    }

    var performance = {
        timeOrigin: _timeOrigin,

        now: function () {
            return Date.now() - _timeOrigin;
        },

        mark: function (name) {
            var entry = new PerformanceEntry(name, 'mark', this.now(), 0);
            _entries.push(entry);
            return entry;
        },

        measure: function (name, startMark, endMark) {
            var startEntry = null;
            var endEntry = null;
            for (var i = 0; i < _entries.length; i++) {
                if (_entries[i].name === startMark && _entries[i].entryType === 'mark') {
                    startEntry = _entries[i];
                }
                if (_entries[i].name === endMark && _entries[i].entryType === 'mark') {
                    endEntry = _entries[i];
                }
            }
            var startTime = startEntry ? startEntry.startTime : 0;
            var endTime = endEntry ? endEntry.startTime : this.now();
            var duration = endTime - startTime;
            var entry = new PerformanceEntry(name, 'measure', startTime, duration);
            _entries.push(entry);
            return entry;
        },

        getEntriesByName: function (name) {
            var result = [];
            for (var i = 0; i < _entries.length; i++) {
                if (_entries[i].name === name) result.push(_entries[i]);
            }
            return result;
        },

        getEntriesByType: function (type) {
            var result = [];
            for (var i = 0; i < _entries.length; i++) {
                if (_entries[i].entryType === type) result.push(_entries[i]);
            }
            return result;
        },

        getEntries: function () {
            return _entries.slice();
        },

        clearMarks: function (name) {
            if (name !== undefined) {
                _entries = _entries.filter(function (e) {
                    return !(e.entryType === 'mark' && e.name === name);
                });
            } else {
                _entries = _entries.filter(function (e) {
                    return e.entryType !== 'mark';
                });
            }
        },

        clearMeasures: function (name) {
            if (name !== undefined) {
                _entries = _entries.filter(function (e) {
                    return !(e.entryType === 'measure' && e.name === name);
                });
            } else {
                _entries = _entries.filter(function (e) {
                    return e.entryType !== 'measure';
                });
            }
        }
    };

    function PerformanceObserver(callback) {
        this._callback = callback;
        this._entryTypes = [];
    }
    PerformanceObserver.prototype.observe = function (options) {
        if (options && options.entryTypes) {
            this._entryTypes = options.entryTypes;
        }
    };
    PerformanceObserver.prototype.disconnect = function () {
        this._entryTypes = [];
    };

    var module = {
        performance: performance,
        PerformanceObserver: PerformanceObserver
    };

    globalThis.__tsxBuiltinModules.set('perf_hooks', module);
    globalThis.__tsxBuiltinModules.set('node:perf_hooks', module);
})();
