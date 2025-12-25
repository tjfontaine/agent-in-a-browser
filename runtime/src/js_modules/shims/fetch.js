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

            // Build options JSON for Rust
            const fetchOptions = {
                method: options.method || 'GET',
                headers: {},
                body: options.body
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
