// https.js - Node.js https module compatible subset for WASM sandbox
// Thin wrapper providing HTTPS client via __syncFetch__ with default port 443.

(function () {
    var EventEmitter = globalThis.__tsxBuiltinModules.get('events');
    if (!EventEmitter) throw new Error('https module requires events module to be loaded first');

    var streamMod = globalThis.__tsxBuiltinModules.get('stream');
    if (!streamMod) throw new Error('https module requires stream module to be loaded first');

    var Readable = streamMod.Readable;

    // --- IncomingMessage ---
    // Represents an HTTP response received by the client.
    // Extends Readable stream (consistent with http module).
    function IncomingMessage(statusCode, statusMessage, headers, body) {
        Readable.call(this);
        this.statusCode = statusCode;
        this.statusMessage = statusMessage || '';
        this.headers = headers || {};
        this.url = '';
        this.method = null;
        this.httpVersion = '1.1';
        this.complete = false;
        this._body = body || '';
    }
    IncomingMessage.prototype = Object.create(Readable.prototype);
    IncomingMessage.prototype.constructor = IncomingMessage;

    IncomingMessage.prototype._deliver = function () {
        if (this._body && this._body.length > 0) {
            this.push(this._body);
        }
        this.complete = true;
        this.push(null); // signals end
    };

    IncomingMessage.prototype.setEncoding = function () {
        return this;
    };

    // --- ClientRequest ---
    // Writable request object returned by https.request().
    function ClientRequest(options, callback) {
        EventEmitter.call(this);
        this._options = options;
        this._headers = {};
        this._body = '';
        this._ended = false;

        // Copy headers from options
        if (options.headers) {
            var keys = Object.keys(options.headers);
            for (var i = 0; i < keys.length; i++) {
                this._headers[keys[i].toLowerCase()] = options.headers[keys[i]];
            }
        }

        if (typeof callback === 'function') {
            this.once('response', callback);
        }
    }
    ClientRequest.prototype = Object.create(EventEmitter.prototype);
    ClientRequest.prototype.constructor = ClientRequest;

    ClientRequest.prototype.setHeader = function (name, value) {
        this._headers[name.toLowerCase()] = value;
        return this;
    };

    ClientRequest.prototype.getHeader = function (name) {
        return this._headers[name.toLowerCase()];
    };

    ClientRequest.prototype.removeHeader = function (name) {
        delete this._headers[name.toLowerCase()];
        return this;
    };

    ClientRequest.prototype.write = function (data) {
        if (this._ended) throw new Error('write after end');
        this._body += typeof data === 'string' ? data : String(data);
        return true;
    };

    ClientRequest.prototype.end = function (data) {
        if (this._ended) return this;
        if (data !== undefined && data !== null) {
            this.write(data);
        }
        this._ended = true;

        var opts = this._options;
        var hostname = opts.hostname || opts.host || 'localhost';
        // Strip port from host if present (e.g., "example.com:8443")
        var hostOnly = hostname;
        if (hostOnly.indexOf(':') !== -1) {
            hostOnly = hostOnly.split(':')[0];
        }
        var port = opts.port || 443;
        var path = opts.path || '/';
        var method = (opts.method || 'GET').toUpperCase();

        // Build URL — always https
        var portPart = (port === 443) ? '' : ':' + port;
        var url = 'https://' + hostOnly + portPart + path;

        var fetchOptions = {
            method: method,
            headers: this._headers,
            body: (method !== 'GET' && method !== 'HEAD') ? this._body : undefined
        };

        var self = this;
        try {
            var resultJson = globalThis.__syncFetch__(url, JSON.stringify(fetchOptions));
            var result = JSON.parse(resultJson);

            // Convert headers array to object
            var respHeaders = {};
            if (result.headers) {
                if (Array.isArray(result.headers)) {
                    for (var h = 0; h < result.headers.length; h++) {
                        var pair = result.headers[h];
                        if (Array.isArray(pair) && pair.length >= 2) {
                            respHeaders[pair[0].toLowerCase()] = pair[1];
                        }
                    }
                } else if (typeof result.headers === 'object') {
                    var hkeys = Object.keys(result.headers);
                    for (var hk = 0; hk < hkeys.length; hk++) {
                        respHeaders[hkeys[hk].toLowerCase()] = result.headers[hkeys[hk]];
                    }
                }
            }

            var res = new IncomingMessage(
                result.status,
                result.statusText,
                respHeaders,
                result.body || ''
            );

            self.emit('response', res);
            res._deliver();
        } catch (e) {
            self.emit('error', e);
        }

        return this;
    };

    ClientRequest.prototype.abort = function () {
        this._ended = true;
    };

    ClientRequest.prototype.setTimeout = function (ms, cb) {
        if (typeof cb === 'function') this.once('timeout', cb);
        return this;
    };

    // --- Agent ---
    function Agent(options) {
        this.maxSockets = (options && options.maxSockets) || Infinity;
        this.keepAlive = (options && options.keepAlive) || false;
        this.maxFreeSockets = (options && options.maxFreeSockets) || 256;
        this.options = options || {};
    }

    var globalAgent = new Agent();

    // --- Server (stub) ---
    function Server(options, requestListener) {
        EventEmitter.call(this);
        this._options = options || {};
        if (typeof requestListener === 'function') {
            this.on('request', requestListener);
        }
    }
    Server.prototype = Object.create(EventEmitter.prototype);
    Server.prototype.constructor = Server;

    Server.prototype.listen = function () {
        throw new Error('https.Server.listen() is not supported in WASM sandbox');
    };

    Server.prototype.close = function (cb) {
        if (typeof cb === 'function') cb();
        return this;
    };

    Server.prototype.address = function () {
        return null;
    };

    // --- Module API ---

    function parseUrlAndOptions(urlOrOptions, optionsOrCallback, callback) {
        var options;
        var cb;

        if (typeof urlOrOptions === 'string') {
            // Parse URL string
            var parsed = {};
            try {
                // Basic URL parsing
                var url = urlOrOptions;
                // Extract protocol
                var protoEnd = url.indexOf('://');
                if (protoEnd !== -1) {
                    parsed.protocol = url.substring(0, protoEnd + 1);
                    url = url.substring(protoEnd + 3);
                } else {
                    parsed.protocol = 'https:';
                }
                // Extract path
                var pathStart = url.indexOf('/');
                if (pathStart !== -1) {
                    parsed.path = url.substring(pathStart);
                    url = url.substring(0, pathStart);
                } else {
                    parsed.path = '/';
                }
                // Extract port
                var portStart = url.indexOf(':');
                if (portStart !== -1) {
                    parsed.hostname = url.substring(0, portStart);
                    parsed.port = parseInt(url.substring(portStart + 1), 10);
                } else {
                    parsed.hostname = url;
                    parsed.port = 443;
                }
            } catch (e) {
                parsed.hostname = 'localhost';
                parsed.port = 443;
                parsed.path = '/';
            }

            if (typeof optionsOrCallback === 'function') {
                cb = optionsOrCallback;
                options = parsed;
            } else {
                options = {};
                var pkeys = Object.keys(parsed);
                for (var pk = 0; pk < pkeys.length; pk++) {
                    options[pkeys[pk]] = parsed[pkeys[pk]];
                }
                if (typeof optionsOrCallback === 'object' && optionsOrCallback !== null) {
                    var okeys = Object.keys(optionsOrCallback);
                    for (var ok = 0; ok < okeys.length; ok++) {
                        options[okeys[ok]] = optionsOrCallback[okeys[ok]];
                    }
                }
                cb = callback;
            }
        } else if (typeof urlOrOptions === 'object' && urlOrOptions !== null) {
            options = {};
            var ukeys = Object.keys(urlOrOptions);
            for (var uk = 0; uk < ukeys.length; uk++) {
                options[ukeys[uk]] = urlOrOptions[ukeys[uk]];
            }
            // Default port for HTTPS
            if (!options.port) options.port = 443;
            cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        } else {
            options = { hostname: 'localhost', port: 443, path: '/', method: 'GET' };
            cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
        }

        return { options: options, callback: cb };
    }

    function request(urlOrOptions, optionsOrCallback, callback) {
        var parsed = parseUrlAndOptions(urlOrOptions, optionsOrCallback, callback);
        return new ClientRequest(parsed.options, parsed.callback);
    }

    function get(urlOrOptions, optionsOrCallback, callback) {
        var parsed = parseUrlAndOptions(urlOrOptions, optionsOrCallback, callback);
        parsed.options.method = 'GET';
        var req = new ClientRequest(parsed.options, parsed.callback);
        req.end();
        return req;
    }

    function createServer(options, requestListener) {
        if (typeof options === 'function') {
            requestListener = options;
            options = {};
        }
        return new Server(options, requestListener);
    }

    var module = {
        request: request,
        get: get,
        createServer: createServer,
        Agent: Agent,
        globalAgent: globalAgent,
        Server: Server,
        IncomingMessage: IncomingMessage,
        ClientRequest: ClientRequest,
        STATUS_CODES: {
            200: 'OK', 201: 'Created', 204: 'No Content',
            301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
            400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
            404: 'Not Found', 405: 'Method Not Allowed',
            500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable'
        }
    };

    globalThis.__tsxBuiltinModules.set('https', module);
    globalThis.__tsxBuiltinModules.set('node:https', module);
})();
