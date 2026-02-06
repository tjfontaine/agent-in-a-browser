class AbortSignal {
    constructor() {
        this.aborted = false;
        this.reason = undefined;
        this._listeners = [];
    }
    addEventListener(type, callback) {
        if (type === 'abort' && typeof callback === 'function') {
            this._listeners.push(callback);
        }
    }
    removeEventListener(type, callback) {
        if (type !== 'abort') return;
        this._listeners = this._listeners.filter((fn) => fn !== callback);
    }
    _abort(reason) {
        if (this.aborted) return;
        this.aborted = true;
        this.reason = reason;
        for (const listener of this._listeners) {
            try { listener({ type: 'abort' }); } catch (_) { }
        }
    }
}

class AbortController {
    constructor() {
        this.signal = new AbortSignal();
    }
    abort(reason) {
        this.signal._abort(reason || new Error('Aborted'));
    }
}

class Request {
    constructor(input, init = {}) {
        if (typeof input === 'object' && input !== null && input.url) {
            this.url = String(input.url);
            this.method = init.method || input.method || 'GET';
            this.headers = new Headers(init.headers || input.headers || {});
            this.body = init.body !== undefined ? init.body : input.body;
            this.signal = init.signal || input.signal;
        } else {
            this.url = String(input);
            this.method = init.method || 'GET';
            this.headers = new Headers(init.headers || {});
            this.body = init.body;
            this.signal = init.signal;
        }
    }
}

globalThis.AbortController = AbortController;
globalThis.Request = Request;

// Web API fetch function
// Embedded via include_str! for IDE linting support
// Requires __syncFetch__ to be installed by Rust

globalThis.fetch = function (resource, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            // Handle Request objects
            let url = resource;
            if (typeof resource === 'object' && resource.url) {
                url = resource.url;
                options = { ...resource, ...options };
            }

            if (options.signal && options.signal.aborted) {
                reject(new TypeError('Fetch aborted'));
                return;
            }

            // Build options JSON for Rust
            const fetchOptions = {
                method: options.method || 'GET',
                headers: {},
                body: options.body,
                timeoutMs: options.timeoutMs
            };

            // Convert headers to plain object
            if (options.headers) {
                if (options.headers instanceof Headers) {
                    options.headers.forEach((value, name) => {
                        fetchOptions.headers[name] = value;
                    });
                } else if (Array.isArray(options.headers)) {
                    options.headers.forEach(([name, value]) => {
                        fetchOptions.headers[name] = value;
                    });
                } else {
                    fetchOptions.headers = options.headers;
                }
            }

            const resultJson = __syncFetch__(url, JSON.stringify(fetchOptions));
            const result = JSON.parse(resultJson);

            if (result.status === 0 && /timeout/i.test(result.statusText || '')) {
                reject(new TypeError(result.statusText || 'Request timeout'));
                return;
            }

            // Build Headers from response
            const responseHeaders = new Headers(result.headers || []);

            // Resolve with standard Response object
            resolve(new Response(result.body, {
                status: result.status,
                statusText: result.statusText,
                headers: responseHeaders,
                url: url
            }));
        } catch (e) {
            // Reject with error for network failures
            reject(new TypeError('Network request failed: ' + e.message));
        }
    });
};
