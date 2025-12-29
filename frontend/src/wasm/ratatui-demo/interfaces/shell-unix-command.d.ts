/** @module Interface shell:unix/command@0.1.0 **/
export function run(name: string, args: Array<string>, env: ExecEnv, stdin: InputStream, stdout: OutputStream, stderr: OutputStream): number;
export function listCommands(): Array<string>;
export type InputStream = import('./wasi-io-streams.js').InputStream;
export type OutputStream = import('./wasi-io-streams.js').OutputStream;
export interface ExecEnv {
  cwd: string,
  vars: Array<[string, string]>,
}
