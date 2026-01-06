/**
 * @tjfontaine/web-agent-core
 * 
 * Embeddable AI agent for web applications.
 * 
 * @example
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
 * // Streaming
 * for await (const event of agent.send('Hello!')) {
 *   if (event.type === 'chunk') console.log(event.text);
 * }
 * 
 * // One-shot
 * const response = await agent.prompt('Summarize');
 * 
 * agent.destroy();
 * ```
 */

export { WebAgent } from './agent.js';
export type {
    AgentConfig,
    AgentEvent,
    Message,
    MessageRole,
    ToolResultData,
    TaskInfo,
    TaskUpdateInfo,
    TaskCompleteInfo,
} from './types.js';
