/**
 * @tjfontaine/wasi-http-handler
 * 
 * WASI HTTP handler implementation using browser Fetch API.
 * 
 * This package provides a browser-compatible HTTP handler that
 * conforms to the WASI Preview 2 HTTP interface.
 */

// Export the interface
export type {
    WasiHttpHandler,
    TransportHandler,
    HttpMethod,
    FieldValue,
    IFields,
    IIncomingRequest,
    IOutgoingResponse,
    IResponseOutparam,
    IOutgoingHandler,
} from './WasiHttpHandler';

// Export the Fetch implementation
export {
    Fields,
    IncomingRequest,
    IncomingBody,
    IncomingResponse,
    OutgoingResponse,
    OutgoingBody,
    OutgoingRequest,
    ResponseOutparam,
    FutureIncomingResponse,
    FutureTrailers,
    outgoingHandler,
    setTransportHandler,
} from './FetchHttpHandler';

// Export stream classes
export { InputStream, OutputStream, ReadyPollable } from './streams';
