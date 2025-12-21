# Web Agent

Browser-native sandboxed development environment with MCP integration.

## Architecture

**3 Components:**

1. **WASM Runtime** (Rust): Sandboxed TypeScript execution + MCP server
   - Runs in web worker
   - Exports MCP tools: `read_file`, `write_file`, `list_files`, `eval`
   - Uses OPFS for file storage
   - Built as WASI P2 component

2. **Frontend** (TypeScript + Vite): TUI inspired by claude-code
   - Terminal-like interface
   - Connects to WASM MCP server
   - Manages web worker communication

3. **Backend** (TBD - likely Rust): Simple static server + Anthropic proxy
   - Serves frontend assets
   - Proxies requests to Anthropic API
   - Currently planning to replace Node.js with Rust

## Quick Start

### Prerequisites

- Rust 1.83+ with `cargo component` and `wit-deps`
- Node.js 20+ (for frontend only)

```bash
# Install Rust tools
cargo install cargo-component wit-deps cargo-watch

# Build everything
npm install
npm run build

# Development with hot reload
npm run dev
```

This starts:
- WASM component rebuild on Rust changes (cargo watch)
- Frontend dev server on http://localhost:5173

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Build WASM + frontend |
| `npm run build:wasm` | Build WASM component only |
| `npm run build:frontend` | Build frontend only |
| `npm run dev` | Hot reload everything |
| `npm run dev:wasm` | Watch Rust changes |
| `npm run dev:frontend` | Frontend dev server |
| `npm run clean` | Clean all build artifacts |
| `npm test` | Run Rust tests |

## Project Structure

```
web-agent/
├── Cargo.toml           # Rust workspace root
├── package.json         # npm scripts (frontend build)
│
├── runtime/             # WASM MCP component
│   ├── Cargo.toml
│   ├── wit/             # WASI interface definitions
│   └── src/
│       ├── main.rs      # MCP HTTP handler
│       ├── lib.rs       # C-ABI exports
│       ├── mcp_server.rs
│       └── ...
│
├── frontend/            # TUI interface
│   ├── package.json
│   ├── src/
│   │   ├── main.ts
│   │   └── wasm/        # Generated from WASM component
│   └── vite.config.ts
│
└── backend/             # (Future Rust implementation)
    └── TBD - simple static server + proxy
```

## Docker

### Development

```bash
docker-compose up
```

Runs:
- `cargo watch` for WASM rebuilds
- Vite dev server with hot reload

### Production

```bash
docker build -t web-agent .
docker run -p 8080:8080 web-agent
```

Uses Caddy for static file serving (frontend will be updated to proxy API requests when backend is ready).

## Development Workflow

### Working on WASM Component

```bash
npm run dev:wasm
```

Watches `runtime/src/**/*.rs` and rebuilds component automatically.

### Working on Frontend

```bash
npm run dev:frontend
```

After WASM changes, refresh browser to reload the new component.

### Adding WASI Dependencies

```bash
cd runtime
# Edit wit/deps.toml
wit-deps update
cargo component add --target wasi:new-dep@version --path wit/deps/new-dep
cargo component build --release --target wasm32-wasip2
```

## Future Backend

The backend will likely be implemented as a Rust binary in this workspace:

```
backend/
├── Cargo.toml
└── src/
    └── main.rs      # Axum/Actix server for static files + proxy
```

Add to workspace:
```toml
# Cargo.toml
[workspace]
members = ["runtime", "backend"]
```

## Testing

```bash
# All Rust tests
cargo test --workspace

# Specific package
cargo test -p ts-runtime-mcp
```

## WASM Component Details

The runtime exports `wasi:http/incoming-handler@0.2.4` which implements MCP protocol:

- **Tools provided:**
  - `eval`: Execute TypeScript/JavaScript
  - `transpile`: TS → JS conversion
  - `read_file`: Read from OPFS
  - `write_file`: Write to OPFS
  - `list_files`: List OPFS contents

- **Size:** ~3.5 MB (release build)
- **Transpiled JS:** ~500 KB (via jco)

## Environment Variables

**Frontend** (`.env`):
```bash
VITE_API_URL=http://localhost:8080/api
```

**Backend** (when implemented):
```bash
PORT=3000
ANTHROPIC_API_KEY=sk-ant-...
```

## License

MIT

## Quick Start

### Prerequisites

- Node.js 20+
- Rust 1.83+
- Docker (optional)

### Local Development

```bash
# Setup (first time only)
chmod +x setup.sh
./setup.sh

# Build everything
npm run build

# Run development servers
npm run dev
```

### Docker Development

```bash
# Development with hot reload
docker-compose up

# Production build
docker-compose -f docker-compose.prod.yml up

# Build Docker image
npm run docker:build
```

## Build System

The project uses npm workspaces for monorepo management:

```bash
# Install dependencies
npm install

# Build Rust WASM component
npm run build:runtime

# Transpile WASM to JS with jco
npm run build:transpile

# Build frontend & backend
npm run build:workspaces

# Clean all build artifacts
npm run clean

# Run tests
npm run test
```

### Individual Workspace Commands

```bash
# Frontend only
npm run dev -w frontend
npm run build -w frontend

# Backend only
npm run dev -w backend
npm run build -w backend
```

## Project Structure

```
web-agent/
├── runtime/              # Rust WASM component
│   ├── src/
│   │   ├── main.rs      # HTTP handler (MCP server)
│   │   ├── lib.rs       # C-ABI exports
│   │   └── ...
│   ├── wit/             # WASI interface definitions
│   └── Cargo.toml
├── frontend/            # Browser UI
│   ├── src/
│   │   ├── main.ts
│   │   └── wasm/        # Generated WASM bindings
│   └── package.json
├── backend/             # API server
│   ├── src/
│   │   └── index.ts
│   └── package.json
├── package.json         # Workspace root
├── Dockerfile           # Multi-stage build
└── docker-compose.yml   # Development orchestration
```

## WASM Component

The runtime is built as a WASI P2 component that:

- Exports `wasi:http/incoming-handler` interface
- Implements MCP JSON-RPC protocol
- Provides TypeScript execution tools
- Can be transpiled to JS for browser use with `jco`

### Building the Component

```bash
cd runtime
./build-component.sh
```

Output: `target/wasm32-wasip2/release/ts-runtime-mcp.wasm`

### Transpiling for Browser

```bash
npm run build:transpile
```

Generates ES modules in `frontend/src/wasm/mcp-server/`

## Docker

### Multi-stage Build

The Dockerfile uses 4 stages:
1. **rust-builder**: Builds WASM component
2. **frontend-builder**: Transpiles WASM and builds frontend
3. **backend-builder**: Builds backend
4. **production**: Minimal runtime image

### Development Mode

```bash
docker-compose up
```

Features:
- Hot reload for all services
- Rust cargo-watch for WASM rebuilds
- Volume mounts for live code changes
- Separate containers for frontend/backend/rust

### Production Mode

```bash
docker-compose -f docker-compose.prod.yml up
```

Features:
- Optimized multi-stage build
- Minimal runtime image
- Health checks
- Auto-restart

## Development Workflow

1. Make changes to Rust code → auto-rebuilds in Docker
2. Transpile: `npm run build:transpile`
3. Frontend/backend auto-reload

## Environment Variables

Create `.env` files in respective directories:

**backend/.env**
```bash
PORT=3000
ANTHROPIC_API_KEY=your_key_here
NODE_ENV=development
```

**frontend/.env**
```bash
VITE_API_URL=http://localhost:3000
```

## Testing

```bash
# All tests
npm test

# Rust tests only
cd runtime && cargo test

# Component validation
wasm-tools component wit runtime/target/wasm32-wasip2/release/ts-runtime-mcp.wasm
```

## Troubleshooting

### Rust build fails

```bash
rustup update
rustup target add wasm32-wasip2
cargo install cargo-component wit-deps --locked
```

### jco transpile fails

```bash
npm install -g @bytecodealliance/jco@latest
```

### Docker build is slow

Use BuildKit:
```bash
DOCKER_BUILDKIT=1 docker build -t web-agent .
```

## License

MIT
