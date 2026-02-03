#!/bin/bash
# validate-wasi-imports.sh
# Validates that WASIImportRegistry declares all WASM imports.
# Run as Xcode Build Phase to enforce compile-time import coverage.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$PROJECT_DIR/EdgeAgent/Bridge/WASIImportRegistry.swift"
IMPORTS="$PROJECT_DIR/EdgeAgent/Bridge/GeneratedWASMImports.swift"

if [[ ! -f "$IMPORTS" ]]; then
    echo "error: GeneratedWASMImports.swift not found. Run generate-wasm-imports.sh first."
    exit 1
fi

# Extract all imports from both files - look for quoted strings
extract_imports() {
    local file="$1"
    # Simple approach: extract strings between quotes that look like imports
    grep -o '"[a-zA-Z_:/@0-9.-]*"' "$file" 2>/dev/null | \
        tr -d '"' | \
        grep -E "^(wasi:|wasi_snapshot)" | \
        sort | uniq
}

REQUIRED=$(extract_imports "$IMPORTS")
DECLARED=$(extract_imports "$REGISTRY")

# Find missing imports
MISSING=""
while IFS= read -r import; do
    if [[ -n "$import" ]] && ! echo "$DECLARED" | grep -qF "$import"; then
        MISSING="$MISSING$import\n"
    fi
done <<< "$REQUIRED"

if [[ -n "$MISSING" ]]; then
    COUNT=$(echo -e "$MISSING" | grep -c . || true)
    echo "error: $COUNT missing WASI imports in WASIImportRegistry.swift:"
    echo -e "$MISSING" | head -20
    echo ""
    echo "Add these imports to the appropriate provider section in WASIImportRegistry.swift"
    exit 1
fi

echo "✅ All WASM imports are declared in WASIImportRegistry"
