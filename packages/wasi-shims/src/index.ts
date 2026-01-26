/**
 * @tjfontaine/wasi-shims
 * 
 * WASI shims for clocks, streams, and terminal info.
 * 
 * This package provides browser-compatible implementations of
 * WASI Preview 2 interfaces for clocks and I/O streams.
 */

// Export clocks implementation
export * as clocks from './clocks-impl.js';

// Export terminal info implementation
export * as terminalInfo from './terminal-info-impl.js';

// Export stream classes
export { InputStream, OutputStream, ReadyPollable } from './streams.js';

// Export shims
export * from './ghostty-cli-shim.js';
export * from './wasi-http-impl.js';
export * from './poll-impl.js';

// Export OPFS sync bridge
export * as opfsSync from './opfs-sync-bridge.js';
export * from './opfs-filesystem-impl.js';

// Export sync bridges for worker mode
export * from './stdin-sync-bridge.js';
export * from './http-sync-bridge.js';
export * from './worker-bridge.js';
export * from './worker-constants.js';

// Export execution mode detection (single source of truth for hasJSPI)
export * from './execution-mode.js';

// Export error and random shims (replaces @bytecodealliance/preview2-shim)
export * from './error.js';
export * from './random.js';
