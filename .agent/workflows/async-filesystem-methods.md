---
description: When you make a Descriptor method async in opfs-filesystem-impl.ts, you must also add it to jco --async-imports
---

# Adding Async Filesystem Methods

When modifying `opfs-filesystem-impl.ts` and making a `Descriptor` class method `async`, you **MUST** also update the jco transpile command in `package.json`.

## Why?

JSPI (JavaScript Promise Integration) only suspends the WASM stack for methods explicitly listed in `--async-imports`. If a method returns a Promise but isn't listed, WASM will get `undefined` before the Promise resolves.

## Steps

1. Edit the method in `frontend/src/wasm/opfs-filesystem-impl.ts` to be `async`
2. Add the corresponding `--async-imports` flag to the `transpile:component:jspi` script in `frontend/package.json`

### Format

```
--async-imports 'wasi:filesystem/types#[method]descriptor.<method-name>'
```

### Current async methods that require --async-imports

- `[method]descriptor.stat` - stat() on self
- `[method]descriptor.stat-at` - stat on subpath  
- `[method]descriptor.open-at` - open file/directory at subpath
- `[method]descriptor.read-directory` - iterate directory contents
- `[method]descriptor.create-directory-at` - mkdir
- `[method]descriptor.unlink-file-at` - delete file
- `[method]descriptor.remove-directory-at` - rmdir
- `[method]descriptor.rename-at` - move/rename
- `[method]descriptor.symlink-at` - create symlink

1. Run `npm run transpile:component:jspi` to regenerate WASM bindings
2. Test the TUI to verify JSPI suspension works correctly

## Symptoms of Missing async-imports

- `TypeError: "undefined" is not one of the cases of descriptor-type`
- `Uncaught (in promise) <error>` where the error should have been caught
- Async function logs show completion AFTER the error occurs
