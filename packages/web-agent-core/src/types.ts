/**
 * @tjfontaine/web-agent-core
 * 
 * TypeScript types for the embeddable AI agent.
 */

/**
 * MCP server configuration
 */
export interface McpServerConfig {
    /** URL of the MCP server */
    url: string;
    /** Optional friendly name for the server */
    name?: string;
}

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
    /** Optional additional text to append to the built-in system preamble */
    preamble?: string;
    /** Optional complete override of the built-in preamble (mutually exclusive with preamble) */
    preambleOverride?: string;
    /** List of MCP servers to connect to (enables tool calling) */
    mcpServers?: McpServerConfig[];
    /** Maximum number of tool turns before stopping (default: 25) */
    maxTurns?: number;
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
 * Task information for task-based UI
 */
export interface TaskInfo {
    id: string;
    name: string;
    description: string;
}

/**
 * Task update for progress tracking
 */
export interface TaskUpdateInfo {
    id: string;
    status: string;
    progress?: number; // 0-100
}

/**
 * Task completion information
 */
export interface TaskCompleteInfo {
    id: string;
    success: boolean;
    output?: string;
}

/**
 * Model loading progress (for local LLM providers like WebLLM)
 */
export interface ModelLoadingProgress {
    /** Human-readable progress text */
    text: string;
    /** Progress percentage (0.0 to 1.0) */
    progress: number;
}

/**
 * Events emitted during agent streaming
 */
export type AgentEvent =
    // Stream events
    | { type: 'stream-start' }
    | { type: 'chunk'; text: string }
    | { type: 'complete'; text: string }
    | { type: 'error'; error: string }
    // Tool events
    | { type: 'tool-call'; toolName: string }
    | { type: 'tool-result'; data: ToolResultData }
    // Task lifecycle events
    | { type: 'plan-generated'; plan: string }
    | { type: 'task-start'; task: TaskInfo }
    | { type: 'task-update'; update: TaskUpdateInfo }
    | { type: 'task-complete'; result: TaskCompleteInfo }
    // Model loading events (for local LLM providers like WebLLM)
    | { type: 'model-loading'; progress: ModelLoadingProgress }
    // State
    | { type: 'ready' };

/**
 * Internal WASM module types (from jco transpilation)
 */
export interface WasmMcpServerConfig {
    url: string;
    name?: string;
}

export interface WasmAgentConfig {
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
    preamble?: string;
    preambleOverride?: string;
    mcpServers?: WasmMcpServerConfig[];
    maxTurns?: number;
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
    | { tag: 'plan-generated'; val: string }
    | { tag: 'task-start'; val: { id: string; name: string; description: string } }
    | { tag: 'task-update'; val: { id: string; status: string; progress?: number } }
    | { tag: 'task-complete'; val: { id: string; success: boolean; output?: string } }
    | { tag: 'model-loading'; val: { text: string; progress: number } }
    | { tag: 'ready' };

export type AgentHandle = number;

