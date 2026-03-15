//go:build wasip1

// Stubs for OS-level functionality that doesn't exist in WASI.
// These replace platform-specific code in the stripe-cli fork.
package wasmbridge

import (
	"os"
)

// IsTerminal always returns true in WASM since we control the terminal via xterm.js.
func IsTerminal(fd int) bool {
	return true
}

// Hostname returns "wasm" since os.Hostname is not available in WASI.
func Hostname() string {
	return "wasm"
}

// HomeDir returns the WASI filesystem root.
// In our OPFS environment, "/" is the virtual home directory.
func HomeDir() string {
	home := os.Getenv("HOME")
	if home != "" {
		return home
	}
	return "/"
}

// OpenBrowser is a no-op in WASM. Instead of opening a browser,
// we print the URL to stdout so the user can open it manually
// (or the agent can handle it via the terminal).
func OpenBrowser(url string) error {
	// The URL will be printed to stdout by the caller
	return nil
}
