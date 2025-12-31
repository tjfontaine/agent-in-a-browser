# @tjfontaine/wasm-sqlite

SQLite module metadata for the WASM shell.

## Overview

This package provides metadata for the SQLite WASM module, which enables SQLite database operations in the browser sandbox. It exports command information used by the module loader system.

## Installation

```bash
npm install @tjfontaine/wasm-sqlite
```

## Commands

| Command | Description | Mode |
|---------|-------------|------|
| `sqlite3` | SQLite interactive shell | buffered |

## Usage

### Metadata Only

```typescript
import { metadata } from '@tjfontaine/wasm-sqlite';

console.log(metadata);
// {
//   name: 'sqlite-module',
//   commands: [
//     { name: 'sqlite3', mode: 'buffered' },
//   ]
// }
```

### With Registry

```typescript
import { metadata } from '@tjfontaine/wasm-sqlite';
import { registerModule } from '@tjfontaine/wasm-loader';

registerModule({
    ...metadata,
    loader: () => import('../wasm/sqlite-module/sqlite-module.js'),
});
```

## Features

The underlying WASM module provides:

- **Full SQLite functionality** via turso_core
- **Persistent storage** using WASI filesystem (OPFS)
- **In-memory databases** with `:memory:`
- **SQL script execution** from files or stdin

## Example

```bash
# In the web-agent shell
$ sqlite3 mydb.sqlite "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"
$ sqlite3 mydb.sqlite "INSERT INTO users (name) VALUES ('Alice'), ('Bob')"
$ sqlite3 mydb.sqlite "SELECT * FROM users"
1|Alice
2|Bob

# In-memory database
$ sqlite3 :memory: "SELECT sqlite_version()"
3.45.0
```

## Design Pattern

This package exports **metadata only**. The WASM binary is loaded by the consuming application to avoid bundler issues with dynamic imports.

## Related Packages

- `@tjfontaine/wasm-loader` - Core registry system
- `@tjfontaine/wasm-modules` - Aggregator for all modules

## License

MIT
