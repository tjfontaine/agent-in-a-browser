/** @module Interface stripe:bridge/http-bridge@0.1.0 **/
export function request(method: string, url: string, headers: string, body: Uint8Array): number;
export function responseStatus(handle: number): number;
export function responseHeaders(handle: number): string;
export function responseBodyRead(handle: number, maxBytes: number): Uint8Array;
export function responseClose(handle: number): void;
