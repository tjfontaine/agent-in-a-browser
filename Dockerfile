# Multi-stage build for WASM component + static frontend

# Stage 1: Build WASM component
FROM rust:1.83-slim AS wasm-builder

RUN apt-get update && apt-get install -y curl git && rm -rf /var/lib/apt/lists/* && \
    rustup target add wasm32-wasip2 && \
    cargo install wit-deps cargo-component --locked

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY runtime ./runtime

RUN cd runtime && \
    wit-deps update && \
    cargo component build --release --target wasm32-wasip2

# Stage 2: Build frontend
FROM node:20-slim AS frontend-builder

RUN npm install -g @bytecodealliance/jco

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY --from=wasm-builder /app/runtime/target/wasm32-wasip2/release/ts-runtime-mcp.wasm ../runtime/target/wasm32-wasip2/release/

COPY frontend ./
RUN npm run transpile:component && npm run build

# Stage 3: Runtime with Caddy (simple static file server + reverse proxy)
FROM caddy:2-alpine

COPY --from=frontend-builder /app/frontend/dist /srv

# Simple Caddyfile for serving frontend and proxying to Anthropic
RUN echo ':8080 {\n\
    root * /srv\n\
    encode gzip\n\
    file_server\n\
    \n\
    # Proxy /api to backend (when implemented)\n\
    # reverse_proxy /api/* localhost:3000\n\
    }' > /etc/caddy/Caddyfile

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1
