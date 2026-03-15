//go:build wasip1

// Package wasmbridge provides a WebSocket client that routes connections through
// host-provided WASM imports, bridging to the browser's WebSocket API.
//
// This replaces gorilla/websocket which cannot function in WASI (no network stack).
// Used by `stripe listen` for real-time webhook event streaming.
package wasmbridge

import (
	"encoding/binary"
	"fmt"
	"io"
	"sync"
	"unsafe"
)

// Host-imported functions for WebSocket communication.
// Implemented by packages/wasi-shims/src/ws-bridge-impl.ts

//go:wasmimport ws_bridge connect
func hostWSConnect(urlPtr, urlLen uint32) uint32

//go:wasmimport ws_bridge read
func hostWSRead(handle uint32, bufPtr, bufLen uint32) uint32

//go:wasmimport ws_bridge write
func hostWSWrite(handle uint32, dataPtr, dataLen uint32) uint32

//go:wasmimport ws_bridge close
func hostWSClose(handle uint32)

// MessageType represents a WebSocket message type.
type MessageType int

const (
	TextMessage   MessageType = 1
	BinaryMessage MessageType = 2
	CloseMessage  MessageType = 8
	PingMessage   MessageType = 9
	PongMessage   MessageType = 10
)

// Conn represents a WebSocket connection via the host bridge.
type Conn struct {
	handle uint32
	mu     sync.Mutex
	closed bool
}

// Dial opens a WebSocket connection through the host bridge.
func Dial(url string) (*Conn, error) {
	urlBytes := []byte(url)
	handle := hostWSConnect(
		uint32(uintptr(unsafe.Pointer(&urlBytes[0]))),
		uint32(len(urlBytes)),
	)
	if handle == 0 {
		return nil, fmt.Errorf("wasmbridge: failed to connect WebSocket to %s", url)
	}
	return &Conn{handle: handle}, nil
}

// ReadMessage reads the next message from the WebSocket connection.
// Returns the message type and payload.
func (c *Conn) ReadMessage() (MessageType, []byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return 0, nil, io.EOF
	}

	// Read into a buffer. The host prefixes the data with a 1-byte message type
	// followed by the payload.
	buf := make([]byte, 64*1024) // 64KB read buffer
	n := hostWSRead(c.handle, uint32(uintptr(unsafe.Pointer(&buf[0]))), uint32(len(buf)))
	if n == 0 {
		return 0, nil, io.EOF
	}

	if n < 5 {
		return 0, nil, fmt.Errorf("wasmbridge: WebSocket message too short (%d bytes)", n)
	}

	// First 4 bytes: message type (uint32 LE), rest: payload
	msgType := MessageType(binary.LittleEndian.Uint32(buf[:4]))
	payload := make([]byte, n-4)
	copy(payload, buf[4:n])

	return msgType, payload, nil
}

// WriteMessage sends a message on the WebSocket connection.
func (c *Conn) WriteMessage(msgType MessageType, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.closed {
		return fmt.Errorf("wasmbridge: WebSocket connection closed")
	}

	// Prefix data with message type (4 bytes LE)
	frame := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(frame[:4], uint32(msgType))
	copy(frame[4:], data)

	written := hostWSWrite(c.handle, uint32(uintptr(unsafe.Pointer(&frame[0]))), uint32(len(frame)))
	if written == 0 {
		return fmt.Errorf("wasmbridge: failed to write WebSocket message")
	}
	return nil
}

// Close closes the WebSocket connection.
func (c *Conn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.closed {
		c.closed = true
		hostWSClose(c.handle)
	}
	return nil
}
