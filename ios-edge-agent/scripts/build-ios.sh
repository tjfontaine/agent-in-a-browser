#!/bin/bash
# Build script for iOS Edge Agent
# Bundles WASM modules and JS runtime into the Xcode project

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_PROJECT="$(dirname "$SCRIPT_DIR")"
PROJECT_ROOT="$(dirname "$IOS_PROJECT")"
WEB_RUNTIME_DIR="$IOS_PROJECT/EdgeAgent/Resources/WebRuntime"

echo "=== iOS Edge Agent Build Script ==="
echo ""

# Step 1: Build WASM modules
echo ">>> Building WASM modules..."
cd "$PROJECT_ROOT/runtime"
cargo component build --release --target wasm32-wasip2
echo ""

# Step 2: Transpile iOS-specific target directly
# This uses local:// URLs for shim imports that work with WKURLSchemeHandler
echo ">>> Transpiling web-headless-agent-ios (sync mode)..."
cd "$PROJECT_ROOT"
node scripts/transpile.mjs web-headless-agent-ios --sync
echo ""

# Step 3: Copy wasi-shims to where local:// imports expect them
echo ">>> Copying WASI shims..."
mkdir -p "$WEB_RUNTIME_DIR/web-headless-agent-sync/shims"
if [ -d "$PROJECT_ROOT/packages/wasi-shims/browser-dist" ]; then
    cp "$PROJECT_ROOT/packages/wasi-shims/browser-dist/"*.js "$WEB_RUNTIME_DIR/web-headless-agent-sync/shims/"
    echo "  ✓ Copied wasi-shims to web-headless-agent-sync/shims/"
else
    echo "  ⚠ wasi-shims/dist/browser not found - run 'pnpm build' in packages/wasi-shims"
fi

# Step 4: Transpile and copy MCP server (sync mode for Safari/iOS)
echo ">>> Transpiling and copying MCP server..."
cd "$PROJECT_ROOT/frontend"
pnpm run transpile:all

if [ -d "$PROJECT_ROOT/packages/mcp-wasm-server/mcp-server-sync" ]; then
    mkdir -p "$WEB_RUNTIME_DIR/mcp-server-sync"
    cp -R "$PROJECT_ROOT/packages/mcp-wasm-server/mcp-server-sync/"* "$WEB_RUNTIME_DIR/mcp-server-sync/"
    echo "  ✓ Copied mcp-server-sync"
    
    # Copy shims to mcp-server-sync (same shims as headless agent)
    mkdir -p "$WEB_RUNTIME_DIR/mcp-server-sync/shims"
    if [ -d "$PROJECT_ROOT/packages/wasi-shims/browser-dist" ]; then
        cp "$PROJECT_ROOT/packages/wasi-shims/browser-dist/"*.js "$WEB_RUNTIME_DIR/mcp-server-sync/shims/"
        echo "  ✓ Copied wasi-shims to mcp-server-sync/shims/"
    fi
    
    # Patch imports in ts-runtime-mcp.js to use relative shim paths
    MCP_JS="$WEB_RUNTIME_DIR/mcp-server-sync/ts-runtime-mcp.js"
    if [ -f "$MCP_JS" ]; then
        # Replace @tjfontaine/wasi-shims/ with ./shims/
        sed -i '' "s|from '@tjfontaine/wasi-shims/|from './shims/|g" "$MCP_JS"
        sed -i '' "s|import '@tjfontaine/wasi-shims/|import './shims/|g" "$MCP_JS"
        
        # Remove the module-loader-impl import (not needed for iOS standalone)
        # Just comment it out since it's a static import
        sed -i '' "s|import { LazyProcess.*module-loader-impl.js';|// iOS: module-loader-impl not used|g" "$MCP_JS"
        
        echo "  ✓ Patched mcp-server imports for iOS"
    fi
else
    echo "  ⚠ mcp-server-sync not found"
fi

echo ""
echo "=== Build Complete ==="
echo "WebRuntime bundled to: $WEB_RUNTIME_DIR"

# Step 5: Resolve Swift Package Manager dependencies (Swift 6 MCP SDK)
echo ""
echo ">>> Resolving Swift Package Manager dependencies..."
cd "$IOS_PROJECT"
xcodebuild -project EdgeAgent.xcodeproj -scheme EdgeAgent -resolvePackageDependencies 2>&1 | grep -E "(Fetching|Checking|Resolved|resolved|error)" || true
echo "  ✓ SPM packages resolved"

# Step 6: Build iOS app (optional - can also build in Xcode)
if [ "$1" = "--build" ]; then
    echo ""
    echo ">>> Building EdgeAgent for iOS Simulator..."
    xcodebuild -project EdgeAgent.xcodeproj -scheme EdgeAgent \
        -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
        -configuration Debug \
        build 2>&1 | tail -20
    echo ""
    echo "  ✓ Build complete"
else
    echo ""
    echo "To build (optional):"
    echo "  $0 --build"
fi

echo ""
echo "Next steps:"
echo "  1. Open ios-edge-agent/EdgeAgent.xcodeproj in Xcode 16+"
echo "  2. Set your Development Team in Signing & Capabilities"
echo "  3. Build and run on Simulator or device"
