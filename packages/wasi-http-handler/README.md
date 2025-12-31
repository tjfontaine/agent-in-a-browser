# @tjfontaine/wasi-http-handler

WASI HTTP handler using the browser Fetch API.

## Features

- **Transport interception** for routing requests to custom handlers
- **Streaming responses** via ReadableStream
- **Full WASI HTTP types** (Fields, IncomingRequest, OutgoingResponse, etc.)

## Usage

```typescript
import { outgoingHandler, setTransportHandler } from '@tjfontaine/wasi-http-handler';

// Optionally set custom transport for localhost
setTransportHandler(async (method, url, headers, body) => {
  // Handle request
  return { status: 200, headers: [], body: new Uint8Array() };
});
```

## WASI Interface

Implements `wasi:http/outgoing-handler` for use with jco-transpiled WASM components.

## License

MIT
