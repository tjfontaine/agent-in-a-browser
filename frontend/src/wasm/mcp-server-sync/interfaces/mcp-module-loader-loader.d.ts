/** @module Interface mcp:module-loader/loader@0.1.0 **/
export function getLazyModule(command: string): string | undefined;
export function spawnLazyCommand(module: string, command: string, args: Array<string>, env: ExecEnv): LazyProcess;
export interface ExecEnv {
  cwd: string,
  vars: Array<[string, string]>,
}
export type Pollable = import('./wasi-io-poll.js').Pollable;

export class LazyProcess {
  /**
   * This type does not have a public constructor.
   */
  private constructor();
  getReadyPollable(): Pollable;
  isReady(): boolean;
  writeStdin(data: Uint8Array): bigint;
  closeStdin(): void;
  readStdout(maxBytes: bigint): Uint8Array;
  readStderr(maxBytes: bigint): Uint8Array;
  tryWait(): number | undefined;
}
