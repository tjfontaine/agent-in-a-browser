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

---

# Lazy Module Async Methods (Critical!)

When a lazy module (like `git-module.ts`) uses async OPFS operations, special care is needed to ensure JSPI can suspend the WASM stack.

## The Problem

Lazy modules run JavaScript code that calls async OPFS functions. If the LazyProcess methods that WASM calls don't properly `await` the pending promises, **the JavaScript event loop never processes the OPFS operations**, causing hangs.

## Critical Rule: Methods in --async-imports MUST Await Their Promises

If a LazyProcess method is listed in `--async-imports`, it MUST actually await any pending async work. Otherwise JSPI suspends waiting for the Promise, but the JavaScript event loop can't process the pending microtasks.

### Current lazy-process methods in --async-imports

```
--async-imports 'mcp:module-loader/loader#get-lazy-module'
--async-imports 'mcp:module-loader/loader#spawn-lazy-command'
--async-imports 'mcp:module-loader/loader#[method]lazy-process.try-wait'
```

### Example: tryWait() Must Await executionPromise

```typescript
// WRONG - JSPI suspends but Promises never resolve (HANGS!)
async tryWait(): Promise<number | undefined> {
    return this.exitCode;  // Doesn't await anything!
}

// CORRECT - Allows JS event loop to process OPFS Promises
async tryWait(): Promise<number | undefined> {
    if (this.executionPromise && this.exitCode === undefined) {
        await this.executionPromise;  // JSPI suspends here, event loop runs
    }
    return this.exitCode;
}
```

## Symptoms of Missing Awaits

- Commands involving lazy modules (git, tsx, sqlite) **hang indefinitely**
- Debug logs show async operations started but never completed
- `closeStdin() complete` appears before the actual operation finishes
