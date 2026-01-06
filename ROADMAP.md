# Roadmap: Agent Backend Abstraction

## Vision

Decouple the LLM orchestration from the sandbox execution, enabling:

- **LocalAgent**: LLM calls from browser (current architecture)
- **RemoteAgent**: LLM calls from server, tools executed in browser sandbox

Both backends share the same `LocalSandbox` (WASM) and communicate via MCP.

```
┌─────────────────────────────────────────────────────────────────┐
│                        AgentDriver                              │
│  (orchestrates conversation loop, handles events, manages UI)   │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │  AgentBackend     │  (trait/interface)
                    │  - send(message)  │
                    │  - poll() → Event │
                    └─────────┬─────────┘
                              │
          ┌───────────────────┴───────────────────┐
          │                                       │
┌─────────┴─────────┐                   ┌─────────┴─────────┐
│   LocalAgent      │                   │   RemoteAgent     │
│ (LLM in browser)  │                   │ (LLM server-side) │
└─────────┬─────────┘                   └─────────┬─────────┘
          │                                       │
          │  MCP (direct)                         │  MCP (via rendezvous)
          │                                       │
          └───────────────────┬───────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │         LocalSandbox          │
              │  (WASM in browser, OPFS)      │
              └───────────────────────────────┘
```

---

## Phase 1: Extract AgentBackend Trait

**Goal**: Define a common interface that both LocalAgent and RemoteAgent implement.

### Tasks

- [ ] Define `AgentBackend` trait in `runtime/crates/core/`

  ```rust
  pub trait AgentBackend {
      fn send(&mut self, message: String);
      fn poll(&mut self) -> Option<AgentEvent>;
      fn cancel(&mut self);
  }
  ```

- [ ] Refactor `ActiveStream` to work with any `AgentBackend`
- [ ] Extract LLM orchestration from `agent_core.rs` into `LocalAgentBackend`
- [ ] Ensure `web-headless-agent` implements `AgentBackend`

---

## Phase 2: MCP Transport Abstraction

**Goal**: Enable MCP tool calls over different transports (direct vs WebSocket).

### Current State

- MCP calls are direct: WASM `call_tool()` → sandbox worker → execute → return
- HTTP transport uses browser fetch via WASI shims

### Tasks

- [ ] Define `MCPTransport` trait

  ```rust
  pub trait MCPTransport {
      async fn call_tool(&self, name: &str, args: Value) -> Result<Value>;
      async fn list_tools(&self) -> Result<Vec<Tool>>;
  }
  ```

- [ ] Implement `DirectMCPTransport` (current behavior)
- [ ] Implement `WebSocketMCPTransport` for rendezvous pattern

---

## Phase 3: RemoteAgent Implementation

**Goal**: Server-side LLM orchestration with browser-based tool execution.

### Architecture

1. Browser opens WebSocket to server
2. Server runs LLM, emits tool_use
3. Server forwards tool call over WebSocket → browser sandbox
4. Browser executes tool in WASM, returns result over WebSocket
5. Server continues LLM loop with tool result

### Tasks

- [ ] Create WebSocket-based rendezvous server (Cloudflare Worker or Node.js)
- [ ] Implement `RemoteAgentBackend` that:
  - Connects to server via WebSocket
  - Receives `AgentEvent` stream
  - Forwards tool call requests to local sandbox
  - Returns tool results to server
- [ ] Server-side LLM client with tool dispatch over WebSocket

---

## Phase 4: Unified Driver

**Goal**: Single `AgentDriver` that works with any backend.

### Tasks

- [ ] Create `AgentDriver` that accepts `Box<dyn AgentBackend>`
- [ ] Migrate TUI to use `AgentDriver` + `LocalAgentBackend`
- [ ] Migrate headless embed to use `AgentDriver`
- [ ] Add backend selection to config (local vs remote)

---

## Considerations

### Privacy

| Aspect | LocalAgent | RemoteAgent |
|--------|------------|-------------|
| API key location | Browser OPFS | Server config |
| LLM request routing | Direct to provider | Via your server |
| Conversation history | Browser only | Server has access |

### Performance

- LocalAgent: No round-trip for LLM calls (direct to provider)
- RemoteAgent: Extra hop (browser ↔ server ↔ LLM), but server can cache/batch

### Hybrid Mode (Future)

Could support "streaming handoff" where:

- Initial response streams from server (fast first token)
- Tool execution happens locally (privacy)
- Server never sees tool outputs without explicit opt-in
