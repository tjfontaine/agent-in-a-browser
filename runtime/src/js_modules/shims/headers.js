// Web API Headers class
// Embedded via include_str! for IDE linting support

class Headers {
    constructor(init) {
        this._headers = {};
        if (init) {
            if (init instanceof Headers) {
                init.forEach((value, name) => this.append(name, value));
            } else if (Array.isArray(init)) {
                init.forEach(([name, value]) => this.append(name, value));
            } else if (typeof init === 'object') {
                Object.entries(init).forEach(([name, value]) => this.append(name, value));
            }
        }
    }

    append(name, value) {
        const key = name.toLowerCase();
        if (this._headers[key]) {
            this._headers[key] += ', ' + value;
        } else {
            this._headers[key] = String(value);
        }
    }

    delete(name) {
        delete this._headers[name.toLowerCase()];
    }

    get(name) {
        return this._headers[name.toLowerCase()] || null;
    }

    has(name) {
        return name.toLowerCase() in this._headers;
    }

    set(name, value) {
        this._headers[name.toLowerCase()] = String(value);
    }

    entries() {
        return Object.entries(this._headers)[Symbol.iterator]();
    }

    keys() {
        return Object.keys(this._headers)[Symbol.iterator]();
    }

    values() {
        return Object.values(this._headers)[Symbol.iterator]();
    }

    forEach(callback, thisArg) {
        Object.entries(this._headers).forEach(([name, value]) => {
            callback.call(thisArg, value, name, this);
        });
    }

    // For JSON serialization
    toJSON() {
        return this._headers;
    }
}

globalThis.Headers = Headers;
