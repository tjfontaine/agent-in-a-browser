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
export { InputStream, OutputStream, ReadyPollable } from './streams';
