/**
 * @tjfontaine/web-agent-core
 * 
 * TypeScript types for the embeddable AI agent.
 */

/**
 * Agent configuration
 */
export interface AgentConfig {
    /** AI provider: 'anthropic', 'openai', 'gemini', etc. */
    provider: string;
    /** Model name: 'claude-3-5-sonnet-20241022', 'gpt-4', etc. */
    model: string;
    /** API key for the provider */
    apiKey: string;
    /** Optional base URL for custom endpoints */
    baseUrl?: string;
    /** Optional system prompt / preamble */
    preamble?: string;
}

/**
 * Message role in conversation
 */
export type MessageRole = 'user' | 'assistant';

/**
 * A message in the conversation history
 */
export interface Message {
    role: MessageRole;
    content: string;
}

/**
 * Tool result data
 */
export interface ToolResultData {
    name: string;
    output: string;
    isError: boolean;
}

/**
 * Events emitted during agent streaming
 */
export type AgentEvent =
    | { type: 'stream-start' }
    | { type: 'chunk'; text: string }
    | { type: 'complete'; text: string }
    | { type: 'error'; error: string }
    | { type: 'tool-call'; toolName: string }
    | { type: 'tool-result'; data: ToolResultData }
    | { type: 'ready' };

/**
 * Internal WASM module types (from jco transpilation)
 */
export interface WasmAgentConfig {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
    preamble?: string;
}

export interface WasmMessage {
    role: 'user' | 'assistant';
    content: string;
}

export type WasmAgentEvent =
    | { tag: 'stream-start' }
    | { tag: 'stream-chunk'; val: string }
    | { tag: 'stream-complete'; val: string }
    | { tag: 'stream-error'; val: string }
    | { tag: 'tool-call'; val: string }
    | { tag: 'tool-result'; val: { name: string; output: string; isError: boolean } }
    | { tag: 'ready' };

export type AgentHandle = number;
