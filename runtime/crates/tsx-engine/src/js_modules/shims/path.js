// Node.js path module implementation
// Embedded via include_str! for IDE linting support

globalThis.path = {
    sep: '/',
    delimiter: ':',

    join: function (...parts) {
        return parts
            .filter(Boolean)
            .join('/')
            .replace(/\/\/+/g, '/');
    },

    resolve: function (...parts) {
        let resolved = '';
        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i];
            if (!part) continue;

            resolved = resolved ? part + '/' + resolved : part;
            if (part.startsWith('/')) break;
        }

        // Normalize the path
        return this.normalize(resolved.startsWith('/') ? resolved : '/' + resolved);
    },

    normalize: function (p) {
        if (!p) return '.';

        const isAbsolute = p.startsWith('/');
        const parts = p.split('/').filter(Boolean);
        const result = [];

        for (const part of parts) {
            if (part === '..') {
                if (result.length > 0 && result[result.length - 1] !== '..') {
                    result.pop();
                } else if (!isAbsolute) {
                    result.push('..');
                }
            } else if (part !== '.') {
                result.push(part);
            }
        }

        const normalized = result.join('/');
        return isAbsolute ? '/' + normalized : normalized || '.';
    },

    dirname: function (p) {
        if (!p) return '.';
        const parts = p.split('/');
        parts.pop();
        const result = parts.join('/');
        return result || (p.startsWith('/') ? '/' : '.');
    },

    basename: function (p, ext) {
        if (!p) return '';
        const base = p.split('/').pop() || '';
        if (ext && base.endsWith(ext)) {
            return base.slice(0, -ext.length);
        }
        return base;
    },

    extname: function (p) {
        const base = this.basename(p);
        const dotIndex = base.lastIndexOf('.');
        return dotIndex > 0 ? base.slice(dotIndex) : '';
    },

    isAbsolute: function (p) {
        return p.startsWith('/');
    },

    relative: function (from, to) {
        from = this.resolve(from);
        to = this.resolve(to);

        if (from === to) return '';

        const fromParts = from.split('/').filter(Boolean);
        const toParts = to.split('/').filter(Boolean);

        // Find common prefix
        let commonLength = 0;
        while (commonLength < fromParts.length &&
            commonLength < toParts.length &&
            fromParts[commonLength] === toParts[commonLength]) {
            commonLength++;
        }

        // Build relative path
        const ups = fromParts.slice(commonLength).map(() => '..');
        const downs = toParts.slice(commonLength);

        return [...ups, ...downs].join('/') || '.';
    },

    parse: function (p) {
        const dir = this.dirname(p);
        const base = this.basename(p);
        const ext = this.extname(p);
        const name = ext ? base.slice(0, -ext.length) : base;
        const root = p.startsWith('/') ? '/' : '';

        return { root, dir, base, ext, name };
    },

    format: function (pathObject) {
        const dir = pathObject.dir || pathObject.root || '';
        const base = pathObject.base ||
            (pathObject.name || '') + (pathObject.ext || '');
        return dir ? (dir.endsWith('/') ? dir + base : dir + '/' + base) : base;
    }
};
