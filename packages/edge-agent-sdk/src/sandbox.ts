/**
 * EdgeAgentSandbox — boots a WASM MCP sandbox in the browser and connects
 * it to the cloud relay so server-side agents can call tools remotely.
 *
 * Usage:
 * ```typescript
 * import { EdgeAgentSandbox } from '@tjfontaine/edge-agent-sdk';
 *
 * const sandbox = new EdgeAgentSandbox({
 *   sessionId: 'abc123',
 *   tenantId: 'acme',
 *   sessionToken: 'st_abc123_xxx',
 * });
 *
 * await sandbox.initialize();
 * sandbox.onReady(() => console.log('Tools available'));
 * // ... later
 * sandbox.destroy();
 * ```
 */

import {
    RelayClient,
    type RelayState,
    type SandboxFetch,
    getSessionUrl,
    getMcpUrl,
    getRelayWsUrl,
} from '@tjfontaine/edge-agent-session';

/** Shape of the browser-mcp-runtime module (loaded dynamically). */
interface BrowserMcpRuntime {
    initializeMcpRuntime(): Promise<void>;
    callWasmMcpServerFetch(req: Request): Promise<{
        status: number;
        headers: Headers;
        body: ReadableStream;
    }>;
}

export type SandboxState = 'idle' | 'initializing' | 'ready' | 'error' | 'destroyed';

export interface EdgeAgentSandboxOptions {
    /** Session ID */
    sessionId: string;
    /** Tenant ID */
    tenantId: string;
    /** Session token for deployer-created sessions */
    sessionToken?: string;
    /**
     * Custom sandbox fetch function. If provided, skips the built-in
     * browser-mcp-runtime boot and uses this instead.
     * Useful when integrating with an existing WASM sandbox.
     */
    sandboxFetch?: SandboxFetch;
    /** Called when sandbox state changes */
    onStateChange?: (state: SandboxState) => void;
    /** Called when relay connection state changes */
    onRelayStateChange?: (state: RelayState) => void;
}

/**
 * Dynamically import and initialize the browser-mcp-runtime.
 * Returns a fetch function that routes requests to the in-browser WASM MCP server.
 */
async function bootBrowserRuntime(): Promise<SandboxFetch> {
    // Dynamic import — the host page must have @tjfontaine/browser-mcp-runtime
    // available (either bundled or as a dependency).
    // Use a variable to avoid TypeScript module resolution at compile time;
    // the package is a runtime-only peer dependency.
    const moduleId = '@tjfontaine/browser-mcp-runtime';
    const runtime = (await import(/* webpackIgnore: true */ moduleId)) as BrowserMcpRuntime;
    await runtime.initializeMcpRuntime();

    const { callWasmMcpServerFetch } = runtime;

    // Adapt to the SandboxFetch signature (input: string, init?: RequestInit) => Promise<Response>
    return async (input: string, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init);
        const result = await callWasmMcpServerFetch(request);
        return new Response(result.body, {
            status: result.status,
            headers: result.headers,
        });
    };
}

/**
 * Discover the available tool list by calling tools/list on the MCP server.
 */
async function discoverTools(sandboxFetch: SandboxFetch): Promise<unknown[]> {
    try {
        const response = await sandboxFetch('/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/list',
                id: 'sdk-tools-discovery',
            }),
        });

        const body = (await response.json()) as {
            result?: { tools?: unknown[] };
        };

        return body.result?.tools ?? [];
    } catch {
        return [];
    }
}

export class EdgeAgentSandbox {
    private relay: RelayClient | null = null;
    private sandboxFetch: SandboxFetch | null = null;
    private currentState: SandboxState = 'idle';
    private readyCallbacks: Array<() => void> = [];

    readonly sessionId: string;
    readonly tenantId: string;

    private options: EdgeAgentSandboxOptions;

    constructor(options: EdgeAgentSandboxOptions) {
        this.options = options;
        this.sessionId = options.sessionId;
        this.tenantId = options.tenantId;
    }

    /** Current sandbox state */
    get state(): SandboxState {
        return this.currentState;
    }

    /** Current relay connection state */
    get relayState(): RelayState {
        return this.relay?.state ?? 'disconnected';
    }

    /**
     * Initialize the sandbox:
     * 1. Boot the WASM MCP runtime (or use provided sandboxFetch)
     * 2. Discover available tools
     * 3. Connect to the cloud relay
     * 4. Send status + tool list
     */
    async initialize(): Promise<void> {
        if (this.currentState === 'ready' || this.currentState === 'initializing') {
            return;
        }
        if (this.currentState === 'destroyed') {
            throw new Error('Sandbox has been destroyed');
        }

        this.setState('initializing');

        try {
            // Step 1: Get or create sandboxFetch
            if (this.options.sandboxFetch) {
                this.sandboxFetch = this.options.sandboxFetch;
            } else {
                this.sandboxFetch = await bootBrowserRuntime();
            }

            // Step 2: Discover tools
            const tools = await discoverTools(this.sandboxFetch);

            // Step 3: Create relay client and connect
            this.relay = new RelayClient({
                sessionId: this.sessionId,
                tenantId: this.tenantId,
                sandboxFetch: this.sandboxFetch,
                sessionToken: this.options.sessionToken,
                onStateChange: (relayState) => {
                    this.options.onRelayStateChange?.(relayState);

                    // When relay connects, send status + tools
                    if (relayState === 'connected') {
                        this.relay?.sendStatus(true, tools);
                    }
                },
            });

            this.relay.connect();
            this.setState('ready');

            // Fire ready callbacks
            for (const cb of this.readyCallbacks) {
                cb();
            }
        } catch (error) {
            this.setState('error');
            throw error;
        }
    }

    /** Register a callback for when the sandbox becomes ready. */
    onReady(callback: () => void): void {
        if (this.currentState === 'ready') {
            callback();
        } else {
            this.readyCallbacks.push(callback);
        }
    }

    /** Disconnect relay and release resources. */
    destroy(): void {
        if (this.relay) {
            this.relay.disconnect();
            this.relay = null;
        }
        this.sandboxFetch = null;
        this.readyCallbacks = [];
        this.setState('destroyed');
    }

    /** Get the WebSocket URL this sandbox connects to. */
    get wsUrl(): string {
        return this.relay?.getWsUrl() ??
            getRelayWsUrl({ sid: this.sessionId, tenantId: this.tenantId });
    }

    /** Get the MCP HTTP endpoint URL for this session. */
    get mcpUrl(): string {
        return getMcpUrl({ sid: this.sessionId, tenantId: this.tenantId });
    }

    /** Get the browser URL for this session. */
    get browserUrl(): string {
        return getSessionUrl({ sid: this.sessionId, tenantId: this.tenantId });
    }

    private setState(state: SandboxState): void {
        if (this.currentState === state) return;
        this.currentState = state;
        this.options.onStateChange?.(state);
    }
}
