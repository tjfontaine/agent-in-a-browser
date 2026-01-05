/// <reference path="./declarations.d.ts" />
// Declarations for generated WASM modules (created by transpile.mjs)
// Uses wildcard patterns so TypeScript accepts the imports

// MCP Server modules (JSPI and sync variants)
declare module '*/mcp-server-sync/ts-runtime-mcp.js' {
    export const incomingHandler: unknown;
    export const $init: Promise<void> | undefined;
}

declare module '*/mcp-server-jspi/ts-runtime-mcp.js' {
    export const incomingHandler: unknown;
    export const command: unknown;
    export const $init: Promise<void> | undefined;
}

// Lazy-loaded WASM command modules
declare module '*/git/git-module.js' {
    export const command: {
        run: (name: string, args: string[], env: unknown, stdin: unknown, stdout: unknown, stderr: unknown) => number;
        listCommands: () => string[];
    };
}

declare module '*/tsx-engine/tsx-engine.js' {
    export const command: {
        run: (name: string, args: string[], env: unknown, stdin: unknown, stdout: unknown, stderr: unknown) => number;
        listCommands: () => string[];
    };
    export const $init: Promise<void> | undefined;
}

declare module '*/sqlite-module/sqlite-module.js' {
    export const command: {
        run: (name: string, args: string[], env: unknown, stdin: unknown, stdout: unknown, stderr: unknown) => number;
        listCommands: () => string[];
    };
    export const $init: Promise<void> | undefined;
}

declare module '*/ratatui-demo/ratatui-demo.js' {
    export const command: {
        run: (name: string, args: string[], env: unknown, stdin: unknown, stdout: unknown, stderr: unknown) => Promise<number>;
        listCommands: () => string[];
    };
    export const $init: Promise<void> | undefined;
}

// WASI interface types from generated modules
declare module '*/interfaces/wasi-io-streams.js' {
    export interface InputStream { }
    export interface OutputStream { }
}

declare module '*/interfaces/shell-unix-command.js' {
    export interface ExecEnv {
        cwd: string;
        vars: [string, string][];
    }
}

// WorkerGlobalScope for worker detection
declare var WorkerGlobalScope: {
    prototype: WorkerGlobalScope;
    new(): WorkerGlobalScope;
};

interface WorkerGlobalScope extends EventTarget, WindowOrWorkerGlobalScope {
}
