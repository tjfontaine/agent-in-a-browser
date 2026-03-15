# stripe-cli-wasm

Go-compiled Stripe CLI adapted for browser execution as a WASM component.

## Architecture

```
stripe-cli (Go fork)
    ↓ GOOS=wasip1 GOARCH=wasm go build
stripe.wasm (core module)
    ↓ wasm-tools component new --adapt p1→p2
stripe-component.wasm (wasip2 component)
    ↓ wasm-tools compose with Rust shim
stripe_module.wasm (exports shell:unix/command)
    ↓ JCO transpile (scripts/transpile.mjs)
packages/wasm-stripe/wasm/stripe-module.js
    ↓ lazy-loaded by frontend
Browser terminal: `stripe customers list`
```

## Setup

### 1. Fork & Clone stripe-cli

```sh
cd stripe-cli-wasm/
git clone https://github.com/YOUR_FORK/stripe-cli.git
```

### 2. Apply WASM patches to the fork

The Go code needs these modifications for wasip1 compatibility:

**Replace HTTP transport** — In `pkg/stripe/client.go`, inject the WASM bridge `RoundTripper`:

```go
//go:build wasip1

package stripe

import "github.com/stripe/stripe-cli/stripe-cli-wasm/wasm-bridge"

func newHTTPClient(unixSocket string) *http.Client {
    return &http.Client{Transport: &wasmbridge.Transport{}}
}
```

**Replace WebSocket** — In `pkg/websocket/client.go`, use the WASM bridge WebSocket.

**Build-tag exclusions** — Add `//go:build !wasip1` to files using:
- `pkg/rpcservice/` (gRPC server)
- `pkg/plugins/` (HashiCorp go-plugin)
- `pkg/open/` (browser opening)
- `pkg/git/editor.go` (external editor)
- `pkg/useragent/uname_unix.go` (syscall.Uname)

**Stub replacements** — Add `//go:build wasip1` stubs for:
- Signal handling (no-op)
- Terminal detection (always true)
- Keyring (in-memory)
- os.Hostname (returns "wasm")
- homedir (returns "/")

### 3. Download the p1→p2 adapter

```sh
# Download from bytecodealliance/wasmtime releases
curl -L -o adapters/wasi_snapshot_preview1.command.wasm \
  https://github.com/bytecodealliance/wasmtime/releases/latest/download/wasi_snapshot_preview1.command.wasm
```

### 4. Build via Moon

```sh
# Full pipeline: Go build → adapt → compose → transpile
moon run stripe-cli-wasm:compose wasm-stripe:transpile wasm-stripe:transpile-sync
```

Or step by step:
```sh
moon run stripe-cli-wasm:build-go-wasm     # Step 1: Go → wasip1 WASM
moon run stripe-cli-wasm:adapt-component   # Step 2: wasip1 → wasip2 component
moon run stripe-cli-wasm:compose           # Step 3: Compose with Rust shim
moon run wasm-stripe:transpile             # Step 4: JCO transpile (JSPI)
moon run wasm-stripe:transpile-sync        # Step 5: JCO transpile (sync)
```

## Directory Structure

```
stripe-cli-wasm/
├── moon.yml                    # Moon build tasks
├── README.md
├── stripe-cli/                 # Forked stripe-cli repo (git submodule)
├── wasm-bridge/
│   ├── transport.go            # HTTP RoundTripper via //go:wasmimport
│   ├── websocket.go            # WebSocket client via //go:wasmimport
│   └── stubs.go                # OS stubs (terminal, hostname, etc.)
├── wit/
│   ├── http-bridge.wit         # WIT for http_bridge imports
│   └── ws-bridge.wit           # WIT for ws_bridge imports
└── adapters/
    └── wasi_snapshot_preview1.command.wasm  # p1→p2 adapter (downloaded)
```

## JS Shims

The host-side implementations of the WASM imports live in `packages/wasi-shims/src/`:

- `http-bridge-impl.ts` — Implements `http_bridge` using browser `fetch()`
- `ws-bridge-impl.ts` — Implements `ws_bridge` using browser `WebSocket`

These are mapped by JCO in `scripts/transpile.mjs` via `--map` flags.

## Risks & Known Issues

- **Binary size**: Go WASM binaries are large (~30-50MB). Consider `wasm-opt -Oz` and brotli compression.
- **Goroutine scheduler**: Go's goroutine scheduler in WASM is single-threaded. Concurrent HTTP requests are serialized.
- **CORS**: Browser cross-origin restrictions apply. Stripe API calls may need the CORS proxy (`/cors-proxy`).
- **Custom sections**: Go's wasip1 output may include custom sections that `wasm-tools component new` doesn't handle. Use `wasm-tools strip` if needed.
