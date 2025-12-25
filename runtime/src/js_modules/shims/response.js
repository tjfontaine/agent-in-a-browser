// Web API Response class
// Embedded via include_str! for IDE linting support

class Response {
    constructor(body, init = {}) {
        this._body = body || '';
        this._bodyUsed = false;
        this.status = init.status || 200;
        this.statusText = init.statusText || '';
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = new Headers(init.headers);
        this.type = 'basic';
        this.url = init.url || '';
        this.redirected = false;
    }

    get body() {
        return null; // No ReadableStream support
    }

    get bodyUsed() {
        return this._bodyUsed;
    }

    text() {
        this._bodyUsed = true;
        return Promise.resolve(this._body);
    }

    json() {
        this._bodyUsed = true;
        try {
            return Promise.resolve(JSON.parse(this._body));
        } catch (e) {
            return Promise.reject(e);
        }
    }

    arrayBuffer() {
        this._bodyUsed = true;
        const encoder = new TextEncoder();
        return Promise.resolve(encoder.encode(this._body).buffer);
    }

    blob() {
        return Promise.reject(new Error('Blob not supported in this environment'));
    }

    formData() {
        return Promise.reject(new Error('FormData not supported in this environment'));
    }

    clone() {
        if (this._bodyUsed) {
            throw new TypeError('Cannot clone a Response whose body is already used');
        }
        return new Response(this._body, {
            status: this.status,
            statusText: this.statusText,
            headers: this.headers,
            url: this.url
        });
    }
}

globalThis.Response = Response;
