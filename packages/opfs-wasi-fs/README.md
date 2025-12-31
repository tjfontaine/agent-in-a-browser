# @tjfontaine/opfs-wasi-fs

WASI filesystem implementation backed by OPFS (Origin Private File System).

## Features

- **SyncAccessHandle** for synchronous file I/O in Web Workers
- **Lazy directory scanning** - directories loaded on first access
- **SharedArrayBuffer bridge** for true synchronous blocking
- **Symlink support** via IndexedDB persistence

## Usage

```typescript
import { initFilesystem, preopens, types } from '@tjfontaine/opfs-wasi-fs';

// Initialize filesystem
await initFilesystem();

// Get root directory
const [[rootDesc, path]] = preopens.getDirectories();

// Open a file
const file = await rootDesc.openAt(0, 'myfile.txt', { create: true }, 0, 0);
```

## WASI Interface

Implements `wasi:filesystem/*` for use with jco-transpiled WASM components.

## License

MIT
