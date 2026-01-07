// world root:component/root
export interface McpServerConfig {
  url: string,
  name?: string,
}
export interface AgentConfig {
  provider: string,
  model: string,
  apiKey: string,
  baseUrl?: string,
  preamble?: string,
  preambleOverride?: string,
  mcpServers?: Array<McpServerConfig>,
  maxTurns?: number,
}
/**
* # Variants
* 
* ## `"user"`
* 
* ## `"assistant"`
*/
export type MessageRole = 'user' | 'assistant';
export interface Message {
  role: MessageRole,
  content: string,
}
export interface ToolResultData {
  name: string,
  output: string,
  isError: boolean,
}
export interface TaskInfo {
  id: string,
  name: string,
  description: string,
}
export interface TaskUpdateInfo {
  id: string,
  status: string,
  progress?: number,
}
export interface TaskCompleteInfo {
  id: string,
  success: boolean,
  output?: string,
}
export type AgentEvent = AgentEventStreamStart | AgentEventStreamChunk | AgentEventStreamComplete | AgentEventStreamError | AgentEventToolCall | AgentEventToolResult | AgentEventPlanGenerated | AgentEventTaskStart | AgentEventTaskUpdate | AgentEventTaskComplete | AgentEventReady;
export interface AgentEventStreamStart {
  tag: 'stream-start',
}
export interface AgentEventStreamChunk {
  tag: 'stream-chunk',
  val: string,
}
export interface AgentEventStreamComplete {
  tag: 'stream-complete',
  val: string,
}
export interface AgentEventStreamError {
  tag: 'stream-error',
  val: string,
}
export interface AgentEventToolCall {
  tag: 'tool-call',
  val: string,
}
export interface AgentEventToolResult {
  tag: 'tool-result',
  val: ToolResultData,
}
export interface AgentEventPlanGenerated {
  tag: 'plan-generated',
  val: string,
}
export interface AgentEventTaskStart {
  tag: 'task-start',
  val: TaskInfo,
}
export interface AgentEventTaskUpdate {
  tag: 'task-update',
  val: TaskUpdateInfo,
}
export interface AgentEventTaskComplete {
  tag: 'task-complete',
  val: TaskCompleteInfo,
}
export interface AgentEventReady {
  tag: 'ready',
}
export type AgentHandle = number;
export type * as WasiCliEnvironment026 from './interfaces/wasi-cli-environment.js'; // import wasi:cli/environment@0.2.6
export type * as WasiCliExit026 from './interfaces/wasi-cli-exit.js'; // import wasi:cli/exit@0.2.6
export type * as WasiCliStderr026 from './interfaces/wasi-cli-stderr.js'; // import wasi:cli/stderr@0.2.6
export type * as WasiClocksMonotonicClock026 from './interfaces/wasi-clocks-monotonic-clock.js'; // import wasi:clocks/monotonic-clock@0.2.6
export type * as WasiHttpOutgoingHandler024 from './interfaces/wasi-http-outgoing-handler.js'; // import wasi:http/outgoing-handler@0.2.4
export type * as WasiHttpTypes024 from './interfaces/wasi-http-types.js'; // import wasi:http/types@0.2.4
export type * as WasiIoError026 from './interfaces/wasi-io-error.js'; // import wasi:io/error@0.2.6
export type * as WasiIoPoll026 from './interfaces/wasi-io-poll.js'; // import wasi:io/poll@0.2.6
export type * as WasiIoStreams026 from './interfaces/wasi-io-streams.js'; // import wasi:io/streams@0.2.6
export type * as WasiRandomInsecureSeed026 from './interfaces/wasi-random-insecure-seed.js'; // import wasi:random/insecure-seed@0.2.6
export function create(config: AgentConfig): AgentHandle;
export function destroy(handle: AgentHandle): void;
export function send(handle: AgentHandle, message: string): void;
export function poll(handle: AgentHandle): AgentEvent | undefined;
export function cancel(handle: AgentHandle): void;
export function plan(handle: AgentHandle, message: string): void;
export function execute(handle: AgentHandle): void;
export function getHistory(handle: AgentHandle): Array<Message>;
export function clearHistory(handle: AgentHandle): void;

export const $init: Promise<void>;
