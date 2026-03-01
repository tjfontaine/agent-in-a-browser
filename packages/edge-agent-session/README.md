# @tjfontaine/edge-agent-session

Shared session types, URL builders, wire protocol definitions, and relay client for the Edge Agent cloud relay system.

## Overview

This package is the canonical source for:

- **Session types** — `SessionInfo`, session ID generation, hostname parsing
- **Wire protocol** — Message types for the relay WebSocket (browser <-> cloud)
- **URL builders** — Construct session, MCP, and WebSocket URLs from session info
- **RelayClient** — WebSocket client connecting a browser WASM sandbox to the cloud relay

## Install

```sh
pnpm add @tjfontaine/edge-agent-session
```

## Usage

### URL Builders

```typescript
import { getSessionUrl, getMcpUrl, getRelayWsUrl, generateSessionId } from '@tjfontaine/edge-agent-session';

const sid = generateSessionId();
const opts = { sid, tenantId: 'acme' };

getSessionUrl(opts);  // https://{sid}.acme.sessions.edge-agent.dev
getMcpUrl(opts);      // https://{sid}.acme.sessions.edge-agent.dev/mcp
getRelayWsUrl(opts);  // wss://{sid}.acme.sessions.edge-agent.dev/relay/ws
```

### Session Hostname Parsing

```typescript
import { parseSessionHostname, getCurrentSession } from '@tjfontaine/edge-agent-session';

parseSessionHostname('abc123.acme.sessions.edge-agent.dev');
// { sid: 'abc123', tenantId: 'acme' }

// In a browser on a session subdomain:
const session = getCurrentSession();
```

### RelayClient

```typescript
import { RelayClient } from '@tjfontaine/edge-agent-session/relay-client';

const client = new RelayClient({
  sessionId: 'abc123',
  tenantId: 'acme',
  sandboxFetch: async (input, init) => {
    // Route MCP requests to your WASM sandbox
    return fetch(input, init);
  },
  onStateChange: (state) => console.log('Relay:', state),
});

client.connect();
client.sendStatus(true, tools); // Notify relay that sandbox is ready
```

## Wire Protocol

The relay uses a simple JSON WebSocket protocol:

| Direction | Type | Purpose |
|-----------|------|---------|
| Relay -> Browser | `mcp_request` | Execute an MCP JSON-RPC request |
| Browser -> Relay | `mcp_response` | Return the MCP response |
| Browser -> Relay | `mcp_stream` | Intermediate streaming event |
| Browser -> Relay | `status` | Sandbox readiness + tool list |

## Exports

- `.` — Types, URL builders, session utilities, `RelayClient`
- `./relay-client` — `RelayClient` class (standalone import)

## License

MIT
