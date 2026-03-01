/**
 * @tjfontaine/edge-agent-sdk
 *
 * SDK for embedding Edge Agent sandboxes in third-party websites.
 * Boots a WASM MCP sandbox in the browser and connects it to the
 * cloud relay for remote tool execution by server-side agents.
 *
 * @example
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
 * sandbox.destroy();
 * ```
 */

export { EdgeAgentSandbox } from './sandbox.js';
export type { EdgeAgentSandboxOptions, SandboxState } from './sandbox.js';

// Re-export relay client from the canonical shared package
export { RelayClient } from '@tjfontaine/edge-agent-session';
export type { RelayClientOptions, RelayState, SandboxFetch } from '@tjfontaine/edge-agent-session';
