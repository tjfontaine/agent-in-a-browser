/**
 * @tjfontaine/web-agent-core
 * 
 * WebAgent - Embeddable AI agent for web applications.
 * 
 * Usage:
 * ```typescript
 * import { WebAgent } from '@tjfontaine/web-agent-core';
 * 
 * const agent = new WebAgent({
 *   provider: 'anthropic',
 *   model: 'claude-3-5-sonnet-20241022',
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 * });
 * 
 * await agent.initialize();
 * 
 * // Streaming mode
 * for await (const event of agent.send('Hello!')) {
 *   if (event.type === 'chunk') console.log(event.text);
 * }
 * 
 * // One-shot mode
 * const response = await agent.prompt('Summarize');
 * console.log(response);
 * 
 * agent.destroy();
 * ```
 */

import type { AgentConfig, AgentEvent, Message } from './types.js';

// Import types from the generated WASM bindings
import type {
    AgentConfig as WasmAgentConfig,
    AgentEvent as WasmAgentEvent,
    AgentHandle,
    Message as WasmMessage,
} from './wasm/web-headless-agent.js';

// The WASM module will be loaded dynamically
let wasmModule: WasmModule | null = null;

interface WasmModule {
    create(config: WasmAgentConfig): AgentHandle;
    destroy(handle: AgentHandle): void;
    send(handle: AgentHandle, message: string): void;
    poll(handle: AgentHandle): WasmAgentEvent | undefined;
    cancel(handle: AgentHandle): void;
    getHistory(handle: AgentHandle): WasmMessage[];
    clearHistory(handle: AgentHandle): void;
}

/**
 * Load the WASM module
 */
async function loadWasmModule(): Promise<WasmModule> {
    if (wasmModule) return wasmModule;

    // Initialize WASI shims before loading WASM (required for JSPI async operations)
    console.log('[WebAgent] Initializing WASI shims...');
    // Use dynamic import with type assertion - Vite resolves this at bundle time
    const shims = await import('@tjfontaine/wasi-shims') as { initFilesystem: () => Promise<void> };
    await shims.initFilesystem();
    console.log('[WebAgent] WASI shims initialized');

    // Dynamic import of the jco-transpiled module
    const mod = await import('./wasm/web-headless-agent.js');
    wasmModule = mod as unknown as WasmModule;
    return wasmModule;
}

/**
 * Convert WASM event to TypeScript event
 */
function mapEvent(event: WasmAgentEvent): AgentEvent {
    switch (event.tag) {
        case 'stream-start':
            return { type: 'stream-start' };
        case 'stream-chunk':
            return { type: 'chunk', text: event.val };
        case 'stream-complete':
            return { type: 'complete', text: event.val };
        case 'stream-error':
            return { type: 'error', error: event.val };
        case 'tool-call':
            return { type: 'tool-call', toolName: event.val };
        case 'tool-result':
            return { type: 'tool-result', data: event.val };
        case 'plan-generated':
            return { type: 'plan-generated', plan: event.val };
        case 'task-start':
            return { type: 'task-start', task: event.val };
        case 'task-update':
            return { type: 'task-update', update: event.val };
        case 'task-complete':
            return { type: 'task-complete', result: event.val };
        case 'ready':
            return { type: 'ready' };
        default:
            throw new Error(`Unknown event type: ${JSON.stringify(event)}`);
    }
}

/**
 * Convert config to WASM format
 */
function toWasmConfig(config: AgentConfig): WasmAgentConfig {
    return {
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        preamble: config.preamble,
        preambleOverride: config.preambleOverride,
        mcpUrl: config.mcpUrl,
        maxTurns: config.maxTurns,
    };
}

/**
 * Convert WASM message to TypeScript message
 */
function mapMessage(msg: WasmMessage): Message {
    return {
        role: msg.role,
        content: msg.content,
    };
}

/**
 * WebAgent - Main class for interacting with the AI agent
 */
export class WebAgent {
    private handle: AgentHandle | null = null;
    private wasm: WasmModule | null = null;
    private _isInitialized = false;

    constructor(private config: AgentConfig) { }

    /**
     * Initialize the agent (loads WASM module)
     */
    async initialize(): Promise<void> {
        if (this._isInitialized) return;

        this.wasm = await loadWasmModule();
        this.handle = await this.wasm.create(toWasmConfig(this.config));
        this._isInitialized = true;
    }

    /**
     * Check if the agent is initialized
     */
    get isInitialized(): boolean {
        return this._isInitialized;
    }

    /**
     * Send a message and get an async iterator of events
     */
    async *send(message: string): AsyncGenerator<AgentEvent> {
        if (!this.handle || !this.wasm) {
            throw new Error('Agent not initialized. Call initialize() first.');
        }

        await this.wasm.send(this.handle, message);

        // Poll for events
        while (true) {
            const event = await this.wasm.poll(this.handle);

            if (!event) {
                // No event available, wait a bit
                await new Promise(r => setTimeout(r, 10));
                continue;
            }

            const mapped = mapEvent(event);
            yield mapped;

            // Stop polling on terminal events
            if (mapped.type === 'complete' || mapped.type === 'error' || mapped.type === 'ready') {
                break;
            }
        }
    }

    /**
     * Send a message and wait for the complete response
     */
    async prompt(message: string): Promise<string> {
        let result = '';

        for await (const event of this.send(message)) {
            if (event.type === 'chunk') {
                result += event.text;
            } else if (event.type === 'complete') {
                return event.text;
            } else if (event.type === 'error') {
                throw new Error(event.error);
            }
        }

        return result;
    }

    /**
     * Cancel the current stream
     */
    cancel(): void {
        if (this.handle && this.wasm) {
            this.wasm.cancel(this.handle);
        }
    }

    /**
     * Get conversation history
     */
    getHistory(): Message[] {
        if (!this.handle || !this.wasm) {
            return [];
        }
        return this.wasm.getHistory(this.handle).map(mapMessage);
    }

    /**
     * Clear conversation history
     */
    clearHistory(): void {
        if (this.handle && this.wasm) {
            this.wasm.clearHistory(this.handle);
        }
    }

    /**
     * Destroy the agent and release resources
     */
    destroy(): void {
        if (this.handle && this.wasm) {
            this.wasm.destroy(this.handle);
            this.handle = null;
        }
        this._isInitialized = false;
    }
}
