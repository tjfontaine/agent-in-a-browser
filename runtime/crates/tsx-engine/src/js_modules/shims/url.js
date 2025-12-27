// Web API URL and URLSearchParams
// Embedded via include_str! for IDE linting support

class URLSearchParams {
    constructor(init) {
        this._params = [];

        if (typeof init === 'string') {
            // Remove leading '?' if present
            if (init.startsWith('?')) init = init.slice(1);

            for (const pair of init.split('&')) {
                if (!pair) continue;
                const [key, ...rest] = pair.split('=');
                const value = rest.join('=');
                this._params.push([
                    decodeURIComponent(key.replace(/\+/g, ' ')),
                    decodeURIComponent((value || '').replace(/\+/g, ' '))
                ]);
            }
        } else if (Array.isArray(init)) {
            for (const [key, value] of init) {
                this._params.push([String(key), String(value)]);
            }
        } else if (init && typeof init === 'object') {
            for (const [key, value] of Object.entries(init)) {
                this._params.push([String(key), String(value)]);
            }
        }
    }

    append(name, value) {
        this._params.push([String(name), String(value)]);
    }

    delete(name) {
        this._params = this._params.filter(([k]) => k !== name);
    }

    get(name) {
        const entry = this._params.find(([k]) => k === name);
        return entry ? entry[1] : null;
    }

    getAll(name) {
        return this._params.filter(([k]) => k === name).map(([, v]) => v);
    }

    has(name) {
        return this._params.some(([k]) => k === name);
    }

    set(name, value) {
        let found = false;
        this._params = this._params.filter(([k]) => {
            if (k === name && !found) {
                found = true;
                return true;
            }
            return k !== name;
        });

        if (found) {
            const idx = this._params.findIndex(([k]) => k === name);
            this._params[idx][1] = String(value);
        } else {
            this._params.push([String(name), String(value)]);
        }
    }

    sort() {
        this._params.sort((a, b) => a[0].localeCompare(b[0]));
    }

    toString() {
        return this._params
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
    }

    entries() {
        return this._params[Symbol.iterator]();
    }

    keys() {
        return this._params.map(([k]) => k)[Symbol.iterator]();
    }

    values() {
        return this._params.map(([, v]) => v)[Symbol.iterator]();
    }

    forEach(callback, thisArg) {
        for (const [key, value] of this._params) {
            callback.call(thisArg, value, key, this);
        }
    }

    [Symbol.iterator]() {
        return this.entries();
    }
}

class URL {
    constructor(url, base) {
        let fullUrl = url;

        if (base) {
            // Handle relative URLs
            const baseUrl = new URL(base);

            if (url.startsWith('//')) {
                fullUrl = baseUrl.protocol + url;
            } else if (url.startsWith('/')) {
                fullUrl = baseUrl.origin + url;
            } else if (url.startsWith('?')) {
                fullUrl = baseUrl.origin + baseUrl.pathname + url;
            } else if (url.startsWith('#')) {
                fullUrl = baseUrl.href.split('#')[0] + url;
            } else if (!url.includes('://')) {
                const basePath = baseUrl.pathname.slice(0, baseUrl.pathname.lastIndexOf('/') + 1);
                fullUrl = baseUrl.origin + basePath + url;
            }
        }

        this._parse(fullUrl);
    }

    _parse(url) {
        // Match protocol
        const protocolMatch = url.match(/^([a-z][a-z0-9+.-]*):\/\//i);
        if (!protocolMatch) {
            throw new TypeError(`Invalid URL: ${url}`);
        }

        this._protocol = protocolMatch[1].toLowerCase() + ':';
        let rest = url.slice(protocolMatch[0].length);

        // Extract hash
        const hashIndex = rest.indexOf('#');
        if (hashIndex !== -1) {
            this._hash = rest.slice(hashIndex);
            rest = rest.slice(0, hashIndex);
        } else {
            this._hash = '';
        }

        // Extract search
        const searchIndex = rest.indexOf('?');
        if (searchIndex !== -1) {
            this._search = rest.slice(searchIndex);
            rest = rest.slice(0, searchIndex);
        } else {
            this._search = '';
        }

        // Extract auth, host, and pathname
        const pathIndex = rest.indexOf('/');
        let hostPart = pathIndex !== -1 ? rest.slice(0, pathIndex) : rest;
        this._pathname = pathIndex !== -1 ? rest.slice(pathIndex) : '/';

        // Extract username:password
        const atIndex = hostPart.indexOf('@');
        if (atIndex !== -1) {
            const auth = hostPart.slice(0, atIndex);
            hostPart = hostPart.slice(atIndex + 1);

            const colonIndex = auth.indexOf(':');
            if (colonIndex !== -1) {
                this._username = decodeURIComponent(auth.slice(0, colonIndex));
                this._password = decodeURIComponent(auth.slice(colonIndex + 1));
            } else {
                this._username = decodeURIComponent(auth);
                this._password = '';
            }
        } else {
            this._username = '';
            this._password = '';
        }

        // Extract hostname and port
        const portMatch = hostPart.match(/:(\d+)$/);
        if (portMatch) {
            this._port = portMatch[1];
            this._hostname = hostPart.slice(0, -portMatch[0].length);
        } else {
            this._port = '';
            this._hostname = hostPart;
        }

        this._searchParams = new URLSearchParams(this._search);
    }

    get protocol() { return this._protocol; }
    set protocol(v) { this._protocol = v.endsWith(':') ? v : v + ':'; }

    get username() { return this._username; }
    set username(v) { this._username = v; }

    get password() { return this._password; }
    set password(v) { this._password = v; }

    get hostname() { return this._hostname; }
    set hostname(v) { this._hostname = v; }

    get port() { return this._port; }
    set port(v) { this._port = String(v); }

    get host() {
        return this._port ? `${this._hostname}:${this._port}` : this._hostname;
    }
    set host(v) {
        const portMatch = v.match(/:(\d+)$/);
        if (portMatch) {
            this._port = portMatch[1];
            this._hostname = v.slice(0, -portMatch[0].length);
        } else {
            this._port = '';
            this._hostname = v;
        }
    }

    get origin() {
        return `${this._protocol}//${this.host}`;
    }

    get pathname() { return this._pathname; }
    set pathname(v) { this._pathname = v.startsWith('/') ? v : '/' + v; }

    get search() { return this._searchParams.toString() ? '?' + this._searchParams.toString() : ''; }
    set search(v) {
        this._search = v.startsWith('?') ? v : '?' + v;
        this._searchParams = new URLSearchParams(v);
    }

    get searchParams() { return this._searchParams; }

    get hash() { return this._hash; }
    set hash(v) { this._hash = v.startsWith('#') ? v : '#' + v; }

    get href() {
        let auth = '';
        if (this._username) {
            auth = this._password
                ? `${encodeURIComponent(this._username)}:${encodeURIComponent(this._password)}@`
                : `${encodeURIComponent(this._username)}@`;
        }
        return `${this._protocol}//${auth}${this.host}${this._pathname}${this.search}${this._hash}`;
    }
    set href(v) { this._parse(v); }

    toString() { return this.href; }
    toJSON() { return this.href; }
}

globalThis.URL = URL;
globalThis.URLSearchParams = URLSearchParams;
