/**
 * WASI HTTP Handler Interface
 * 
 * Abstract interface for WASI HTTP implementations.
 * This allows different backends (fetch, custom transport, etc.) to be plugged in.
 */

/**
 * HTTP request method
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

/**
 * HTTP field value (can be binary)
 */
export type FieldValue = Uint8Array;

/**
 * HTTP headers interface
 */
export interface IFields {
    get(name: string): FieldValue[];
    has(name: string): boolean;
    set(name: string, value: FieldValue[]): void;
    append(name: string, value: FieldValue): void;
    delete(name: string): void;
    clone(): IFields;
    entries(): [string, FieldValue][];
}

/**
 * Incoming HTTP request interface
 */
export interface IIncomingRequest {
    method(): HttpMethod;
    pathWithQuery(): string | undefined;
    scheme(): { tag: string } | undefined;
    authority(): string | undefined;
    headers(): IFields;
    consume(): unknown; // Returns IIncomingBody
}

/**
 * Outgoing HTTP response interface
 */
export interface IOutgoingResponse {
    statusCode(): number;
    headers(): IFields;
    body(): unknown; // Returns IOutgoingBody
}

/**
 * Response outparam for setting the response
 */
export interface IResponseOutparam {
    set(result: { tag: 'ok'; val: IOutgoingResponse } | { tag: 'err'; val: unknown }): void;
}

/**
 * Outgoing HTTP handler interface
 */
export interface IOutgoingHandler {
    handle(request: unknown, options?: unknown): unknown; // Returns FutureIncomingResponse
}

/**
 * Transport handler for intercepting requests
 */
export type TransportHandler = (
    method: string,
    url: string,
    headers: [string, Uint8Array][],
    body: Uint8Array | null
) => Promise<{
    status: number;
    headers: [string, Uint8Array][];
    body: Uint8Array;
}>;

/**
 * Complete WASI HTTP Handler interface
 * 
 * Implements the wasi:http interface for browser environments.
 */
export interface WasiHttpHandler {
    /** Set a custom transport handler for intercepting HTTP requests */
    setTransportHandler(handler: TransportHandler | null): void;

    /** Fields class for HTTP headers */
    Fields: new (fields?: [string, Uint8Array[]][]) => IFields;

    /** Create an incoming request */
    IncomingRequest: new (...args: unknown[]) => IIncomingRequest;

    /** Create an outgoing response */
    OutgoingResponse: new (headers: IFields) => IOutgoingResponse;

    /** ResponseOutparam for setting responses */
    ResponseOutparam: new () => IResponseOutparam;

    /** Outgoing handler for making HTTP requests */
    outgoingHandler: IOutgoingHandler;
}
