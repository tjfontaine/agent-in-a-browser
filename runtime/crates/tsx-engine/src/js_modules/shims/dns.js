// dns.js - Stub module for WASM sandbox
// DNS resolution is not available in WASM.

(function () {
    var ERR_MSG = 'DNS is not supported in WASM sandbox';

    // --- Callback-style stub functions ---
    // Each normalizes optional arguments and calls the callback with an Error.

    function lookup(hostname, options, cb) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
        if (typeof cb === 'function') {
            cb(new Error(ERR_MSG));
        }
    }

    function resolve(hostname, rrtype, cb) {
        if (typeof rrtype === 'function') {
            cb = rrtype;
            rrtype = 'A';
        }
        if (typeof cb === 'function') {
            cb(new Error(ERR_MSG));
        }
    }

    function resolve4(hostname, options, cb) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
        if (typeof cb === 'function') {
            cb(new Error(ERR_MSG));
        }
    }

    function resolve6(hostname, options, cb) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
        if (typeof cb === 'function') {
            cb(new Error(ERR_MSG));
        }
    }

    function resolveMx(hostname, cb) {
        if (typeof cb === 'function') {
            cb(new Error(ERR_MSG));
        }
    }

    function resolveTxt(hostname, cb) {
        if (typeof cb === 'function') {
            cb(new Error(ERR_MSG));
        }
    }

    function resolveSrv(hostname, cb) {
        if (typeof cb === 'function') {
            cb(new Error(ERR_MSG));
        }
    }

    function resolveNs(hostname, cb) {
        if (typeof cb === 'function') {
            cb(new Error(ERR_MSG));
        }
    }

    function resolveCname(hostname, cb) {
        if (typeof cb === 'function') {
            cb(new Error(ERR_MSG));
        }
    }

    function reverse(ip, cb) {
        if (typeof cb === 'function') {
            cb(new Error(ERR_MSG));
        }
    }

    // --- Promise-based versions ---
    // Each returns a Promise that rejects with the same error.

    function rejectDns() {
        return new Promise(function (resolve, reject) {
            reject(new Error(ERR_MSG));
        });
    }

    var promises = {
        lookup: function () { return rejectDns(); },
        resolve: function () { return rejectDns(); },
        resolve4: function () { return rejectDns(); },
        resolve6: function () { return rejectDns(); },
        resolveMx: function () { return rejectDns(); },
        resolveTxt: function () { return rejectDns(); },
        resolveSrv: function () { return rejectDns(); },
        resolveNs: function () { return rejectDns(); },
        resolveCname: function () { return rejectDns(); },
        reverse: function () { return rejectDns(); }
    };

    // --- Resolver class ---
    // Mirrors the callback-style methods on an instance.

    function Resolver() {}

    Resolver.prototype.resolve = resolve;
    Resolver.prototype.resolve4 = resolve4;
    Resolver.prototype.resolve6 = resolve6;
    Resolver.prototype.resolveMx = resolveMx;
    Resolver.prototype.resolveTxt = resolveTxt;
    Resolver.prototype.resolveSrv = resolveSrv;
    Resolver.prototype.resolveNs = resolveNs;
    Resolver.prototype.resolveCname = resolveCname;
    Resolver.prototype.reverse = reverse;
    Resolver.prototype.setServers = function () {};
    Resolver.prototype.getServers = function () { return []; };
    Resolver.prototype.cancel = function () {};

    // --- Error code constants ---

    var NODATA = 'ENODATA';
    var FORMERR = 'EFORMERR';
    var SERVFAIL = 'ESERVFAIL';
    var NOTFOUND = 'ENOTFOUND';
    var NOTIMP = 'ENOTIMP';
    var REFUSED = 'EREFUSED';
    var BADQUERY = 'EBADQUERY';
    var BADNAME = 'EBADNAME';
    var BADFAMILY = 'EBADFAMILY';
    var BADRESP = 'EBADRESP';
    var CONNREFUSED = 'ECONNREFUSED';
    var TIMEOUT = 'ETIMEOUT';
    var EOF = 'EEOF';
    var NXDOMAIN = 'ENXDOMAIN';
    var FILE = 'EFILE';
    var NOMEM = 'ENOMEM';
    var DESTRUCTION = 'EDESTRUCTION';
    var BADSTR = 'EBADSTR';
    var BADFLAGS = 'EBADFLAGS';
    var NONAME = 'ENONAME';
    var BADHINTS = 'EBADHINTS';
    var NOTINITIALIZED = 'ENOTINITIALIZED';
    var LOADIPHLPAPI = 'ELOADIPHLPAPI';
    var ADDRGETNETWORKPARAMS = 'EADDRGETNETWORKPARAMS';
    var CANCELLED = 'ECANCELLED';

    // --- Module export ---

    var module = {
        lookup: lookup,
        resolve: resolve,
        resolve4: resolve4,
        resolve6: resolve6,
        resolveMx: resolveMx,
        resolveTxt: resolveTxt,
        resolveSrv: resolveSrv,
        resolveNs: resolveNs,
        resolveCname: resolveCname,
        reverse: reverse,
        Resolver: Resolver,
        promises: promises,
        NODATA: NODATA,
        FORMERR: FORMERR,
        SERVFAIL: SERVFAIL,
        NOTFOUND: NOTFOUND,
        NOTIMP: NOTIMP,
        REFUSED: REFUSED,
        BADQUERY: BADQUERY,
        BADNAME: BADNAME,
        BADFAMILY: BADFAMILY,
        BADRESP: BADRESP,
        CONNREFUSED: CONNREFUSED,
        TIMEOUT: TIMEOUT,
        EOF: EOF,
        NXDOMAIN: NXDOMAIN,
        FILE: FILE,
        NOMEM: NOMEM,
        DESTRUCTION: DESTRUCTION,
        BADSTR: BADSTR,
        BADFLAGS: BADFLAGS,
        NONAME: NONAME,
        BADHINTS: BADHINTS,
        NOTINITIALIZED: NOTINITIALIZED,
        LOADIPHLPAPI: LOADIPHLPAPI,
        ADDRGETNETWORKPARAMS: ADDRGETNETWORKPARAMS,
        CANCELLED: CANCELLED
    };

    globalThis.__tsxBuiltinModules.set('dns', module);
    globalThis.__tsxBuiltinModules.set('node:dns', module);
    globalThis.__tsxBuiltinModules.set('dns/promises', promises);
    globalThis.__tsxBuiltinModules.set('node:dns/promises', promises);
})();
