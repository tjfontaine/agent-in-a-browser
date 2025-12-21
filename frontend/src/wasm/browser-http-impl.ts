/**
 * Browser HTTP implementation for WASM component
 * This implements the browser-http WIT interface using sync XMLHttpRequest
 */

/**
 * Perform a synchronous HTTP GET request
 * @param url - The URL to fetch
 * @returns JSON string with {status, ok, body} or {error}
 */
function httpGet(url: string): string {
    console.log('[browser-http] GET', url);
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false); // false = synchronous
        xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
        xhr.send(null);

        console.log('[browser-http] Response status:', xhr.status);

        return JSON.stringify({
            status: xhr.status,
            ok: xhr.status >= 200 && xhr.status < 300,
            body: xhr.responseText
        });
    } catch (err) {
        console.error('[browser-http] Error:', err);
        return JSON.stringify({
            status: 0,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
        });
    }
}

/**
 * Perform a synchronous HTTP request with custom method, headers, body
 * @param method - HTTP method (GET, POST, PUT, DELETE, etc.)
 * @param url - The URL to fetch
 * @param headers - JSON string of headers object
 * @param body - Request body string
 * @returns JSON string with {status, ok, headers, body} or {error}
 */
function httpRequest(method: string, url: string, headers: string, body: string): string {
    console.log('[browser-http]', method, url);
    try {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url, false); // false = synchronous

        // Parse and set headers
        if (headers) {
            try {
                const headerObj = JSON.parse(headers);
                for (const [key, value] of Object.entries(headerObj)) {
                    // Skip restricted headers
                    if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'user-agent') {
                        xhr.setRequestHeader(key, String(value));
                    }
                }
            } catch (e) {
                console.warn('[browser-http] Failed to parse headers:', e);
            }
        }

        xhr.send(body || null);

        console.log('[browser-http] Response status:', xhr.status);

        // Parse response headers
        const responseHeaders: Record<string, string> = {};
        xhr.getAllResponseHeaders()
            .trim()
            .split(/[\r\n]+/)
            .forEach((line) => {
                const parts = line.split(': ');
                const key = parts.shift();
                const value = parts.join(': ');
                if (key) responseHeaders[key] = value;
            });

        return JSON.stringify({
            status: xhr.status,
            ok: xhr.status >= 200 && xhr.status < 300,
            headers: responseHeaders,
            body: xhr.responseText
        });
    } catch (err) {
        console.error('[browser-http] Error:', err);
        return JSON.stringify({
            status: 0,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
        });
    }
}

/**
 * Export the browserHttp interface for jco mapping
 */
export const browserHttp = {
    httpGet,
    httpRequest
};

// Also export individual functions for flexible importing
export { httpGet, httpRequest };
