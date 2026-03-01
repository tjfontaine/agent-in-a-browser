// cluster.js - Stub module for WASM sandbox
// Process clustering is not available in WASM.

(function () {
    var EventEmitter = globalThis.__tsxBuiltinModules.get('events');

    function Cluster() {
        EventEmitter.call(this);
    }
    Cluster.prototype = Object.create(EventEmitter.prototype);
    Cluster.prototype.constructor = Cluster;

    var cluster = new Cluster();

    cluster.isMaster = true;
    cluster.isPrimary = true;
    cluster.isWorker = false;
    cluster.worker = null;
    cluster.workers = {};
    cluster.settings = {};
    cluster.SCHED_NONE = 1;
    cluster.SCHED_RR = 2;
    cluster.schedulingPolicy = 2;

    cluster.setupMaster = function (settings) {
        if (settings) {
            var keys = Object.keys(settings);
            for (var i = 0; i < keys.length; i++) {
                cluster.settings[keys[i]] = settings[keys[i]];
            }
        }
    };

    cluster.setupPrimary = cluster.setupMaster;

    cluster.fork = function () {
        throw new Error('cluster.fork is not supported in WASM sandbox');
    };

    cluster.disconnect = function (cb) {
        if (typeof cb === 'function') {
            cb();
        }
    };

    globalThis.__tsxBuiltinModules.set('cluster', cluster);
    globalThis.__tsxBuiltinModules.set('node:cluster', cluster);
})();
