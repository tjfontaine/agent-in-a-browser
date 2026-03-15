//go:build wasip1

// Package wasmbridge provides an http.RoundTripper implementation that routes
// HTTP requests through host-provided WASM imports, bridging to the browser's
// fetch() API via the JS shim layer.
//
// This replaces Go's net/http.DefaultTransport which cannot function in WASI
// (no network stack). The host functions are implemented in TypeScript as part
// of the wasi-shims package.
package wasmbridge

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"unsafe"
)

// Host-imported functions for HTTP communication.
// These are implemented by the JS runtime (packages/wasi-shims/src/http-bridge-impl.ts)
// and linked at WASM instantiation time.

//go:wasmimport http_bridge request
func hostHTTPRequest(
	methodPtr, methodLen uint32,
	urlPtr, urlLen uint32,
	headersPtr, headersLen uint32,
	bodyPtr, bodyLen uint32,
) uint32

//go:wasmimport http_bridge response_status
func hostResponseStatus(handle uint32) uint32

//go:wasmimport http_bridge response_headers
func hostResponseHeaders(handle uint32, bufPtr, bufLen uint32) uint32

//go:wasmimport http_bridge response_body_read
func hostResponseBodyRead(handle uint32, bufPtr, bufLen uint32) uint32

//go:wasmimport http_bridge response_close
func hostResponseClose(handle uint32)

// Transport implements http.RoundTripper using WASM host imports.
type Transport struct{}

// RoundTrip executes a single HTTP transaction via the host bridge.
func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Marshal method
	method := req.Method
	methodBytes := []byte(method)

	// Marshal URL
	urlStr := req.URL.String()
	urlBytes := []byte(urlStr)

	// Marshal headers as JSON
	headerMap := make(map[string]string)
	for key, values := range req.Header {
		if len(values) > 0 {
			headerMap[key] = values[0]
		}
	}
	headersJSON, err := json.Marshal(headerMap)
	if err != nil {
		return nil, fmt.Errorf("wasmbridge: failed to marshal headers: %w", err)
	}

	// Read request body
	var bodyBytes []byte
	if req.Body != nil {
		bodyBytes, err = io.ReadAll(req.Body)
		if err != nil {
			return nil, fmt.Errorf("wasmbridge: failed to read request body: %w", err)
		}
		req.Body.Close()
	}

	// Call host function
	handle := hostHTTPRequest(
		ptrAndLen(methodBytes),
		ptrAndLen(urlBytes),
		ptrAndLen(headersJSON),
		ptrAndLen(bodyBytes),
	)

	// Get response status
	status := hostResponseStatus(handle)

	// Get response headers
	headersBuf := make([]byte, 64*1024) // 64KB buffer for headers
	headersLen := hostResponseHeaders(handle, uint32(uintptr(unsafe.Pointer(&headersBuf[0]))), uint32(len(headersBuf)))
	var respHeaders map[string]string
	if headersLen > 0 {
		if err := json.Unmarshal(headersBuf[:headersLen], &respHeaders); err != nil {
			respHeaders = make(map[string]string)
		}
	}

	// Build http.Response
	resp := &http.Response{
		StatusCode: int(status),
		Status:     fmt.Sprintf("%d %s", status, http.StatusText(int(status))),
		Header:     make(http.Header),
		Body:       &responseBody{handle: handle},
		Request:    req,
	}

	for key, value := range respHeaders {
		resp.Header.Set(key, value)
	}

	return resp, nil
}

// responseBody implements io.ReadCloser for streaming response data from the host.
type responseBody struct {
	handle uint32
	buf    bytes.Buffer
	closed bool
}

func (r *responseBody) Read(p []byte) (int, error) {
	if r.closed {
		return 0, io.EOF
	}

	// If we have buffered data, return it first
	if r.buf.Len() > 0 {
		return r.buf.Read(p)
	}

	// Read from host
	n := hostResponseBodyRead(r.handle, uint32(uintptr(unsafe.Pointer(&p[0]))), uint32(len(p)))
	if n == 0 {
		return 0, io.EOF
	}
	return int(n), nil
}

func (r *responseBody) Close() error {
	if !r.closed {
		r.closed = true
		hostResponseClose(r.handle)
	}
	return nil
}

// ptrAndLen returns the pointer and length of a byte slice as uint32 values
// suitable for passing to WASM host imports.
func ptrAndLen(b []byte) (uint32, uint32) {
	if len(b) == 0 {
		return 0, 0
	}
	return uint32(uintptr(unsafe.Pointer(&b[0]))), uint32(len(b))
}
