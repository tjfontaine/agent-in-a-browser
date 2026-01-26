//! WASI HTTP Adapter Macro
//!
//! This module provides a macro to generate the WasiHttpClient implementation
//! for any WASM component with WASI HTTP bindings.
//!
//! Since each component has its own WIT-generated bindings at different paths,
//! this macro allows sharing the implementation while using component-specific imports.
//!
//! # Usage
//!
//! ```rust,ignore
//! agent_bridge::define_wasi_http_client!(crate::bindings::wasi);
//! ```

/// Generate a complete WasiHttpClient implementation using the provided WASI bindings paths.
///
/// This macro generates:
/// - `WasiHttpClient` struct implementing `HttpClientExt`
/// - `WasiBodyStream` for streaming response bodies
/// - All necessary helper functions
///
/// # Arguments
///
/// * `$http_mod` - Path to the http module (e.g., `crate::bindings::wasi::http`)
/// * `$io_mod` - Path to the io module (e.g., `crate::bindings::wasi::io`)
#[macro_export]
macro_rules! define_wasi_http_client {
    ($http_mod:path, $io_mod:path) => {
        use bytes::Bytes;
        use futures::stream::Stream;
        use http::{Request, Response};
        use rig::http_client::{
            sse::BoxedStream, Error as RigError, HttpClientExt, LazyBody, MultipartForm,
            Result as RigResult, StreamingResponse,
        };
        use rig::wasm_compat::WasmCompatSend;
        use std::future::Future;
        use std::pin::Pin;
        use std::task::{Context, Poll};

        // Create local aliases for the modules
        use $http_mod as wasi_http;
        use $io_mod as wasi_io;

        // Import types through the aliases
        use wasi_http::{
            outgoing_handler,
            types::{
                Fields, IncomingBody, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme,
            },
        };
        use wasi_io::streams::{InputStream, StreamError};

        /// WASI HTTP Client that implements rig-core's HttpClientExt trait
        ///
        /// This is a stateless, zero-size struct that implements all the traits
        /// required by rig-core's provider clients: HttpClientExt, Clone, Debug, Default.
        #[derive(Clone, Copy, Default, Debug)]
        pub struct WasiHttpClient;

        impl WasiHttpClient {
            pub fn new() -> Self {
                Self
            }

            /// Parse URL into (scheme, authority, path)
            /// Supports http://, https://, and custom schemes like wasm://
            fn parse_url(url: &str) -> RigResult<(Scheme, String, String)> {
                // Find :// to extract scheme
                let scheme_end = url
                    .find("://")
                    .ok_or_else(|| _wasi_http_instance_error("Invalid URL: missing ://"))?;
                let scheme_str = &url[..scheme_end];
                let rest = &url[scheme_end + 3..];

                let scheme = match scheme_str {
                    "https" => Scheme::Https,
                    "http" => Scheme::Http,
                    other => Scheme::Other(other.to_string()),
                };

                let (authority, path) = if let Some(slash_pos) = rest.find('/') {
                    (rest[..slash_pos].to_string(), rest[slash_pos..].to_string())
                } else {
                    (rest.to_string(), "/".to_string())
                };

                Ok((scheme, authority, path))
            }

            /// Convert http::Method to WASI Method
            fn convert_method(method: &http::Method) -> Method {
                match method.as_str() {
                    "GET" => Method::Get,
                    "POST" => Method::Post,
                    "PUT" => Method::Put,
                    "DELETE" => Method::Delete,
                    "HEAD" => Method::Head,
                    "OPTIONS" => Method::Options,
                    "PATCH" => Method::Patch,
                    other => Method::Other(other.to_string()),
                }
            }

            /// Internal method to execute a request and return body bytes
            fn execute_request<T: Into<Bytes>>(&self, req: Request<T>) -> RigResult<(u16, Bytes)> {
                let (parts, body) = req.into_parts();
                let body_bytes: Bytes = body.into();
                let url = parts.uri.to_string();

                let (scheme, authority, path) = Self::parse_url(&url)?;

                // Create WASI headers
                let fields = Fields::new();
                for (name, value) in parts.headers.iter() {
                    let _ = fields.append(&name.to_string(), value.as_bytes());
                }

                // Create request
                let request = OutgoingRequest::new(fields);
                let _ = request.set_method(&Self::convert_method(&parts.method));
                let _ = request.set_scheme(Some(&scheme));
                let _ = request.set_authority(Some(&authority));
                let _ = request.set_path_with_query(Some(&path));

                // Write body if present
                if !body_bytes.is_empty() {
                    let out_body = request
                        .body()
                        .map_err(|_| _wasi_http_instance_error("Failed to get body"))?;
                    let stream = out_body
                        .write()
                        .map_err(|_| _wasi_http_instance_error("Failed to get body stream"))?;

                    stream
                        .blocking_write_and_flush(&body_bytes)
                        .map_err(|e| _wasi_http_instance_error(format!("Write failed: {:?}", e)))?;

                    drop(stream);
                    OutgoingBody::finish(out_body, None).map_err(|e| {
                        _wasi_http_instance_error(format!("Finish failed: {:?}", e))
                    })?;
                }

                // Send request
                let options = RequestOptions::new();
                let future_response = outgoing_handler::handle(request, Some(options))
                    .map_err(|e| _wasi_http_instance_error(format!("Handle failed: {:?}", e)))?;

                // Wait for response (JSPI makes this non-blocking from JS perspective)
                let pollable = future_response.subscribe();
                pollable.block();

                let response_result = future_response
                    .get()
                    .ok_or_else(|| _wasi_http_instance_error("No response"))?
                    .map_err(|_| _wasi_http_instance_error("Response error"))?
                    .map_err(|e| _wasi_http_instance_error(format!("HTTP error: {:?}", e)))?;

                let status = response_result.status();

                // Read body
                let body = response_result
                    .consume()
                    .map_err(|_| _wasi_http_instance_error("Failed to consume body"))?;

                let stream = body
                    .stream()
                    .map_err(|_| _wasi_http_instance_error("Failed to get stream"))?;

                let mut result = Vec::new();
                loop {
                    match stream.blocking_read(64 * 1024) {
                        Ok(chunk) => {
                            if chunk.is_empty() {
                                break;
                            }
                            result.extend_from_slice(&chunk);
                        }
                        Err(StreamError::Closed) => break,
                        Err(e) => {
                            return Err(_wasi_http_instance_error(format!("Read error: {:?}", e)));
                        }
                    }
                }

                Ok((status, Bytes::from(result)))
            }

            /// Internal method to prepare a streaming request (async-compatible)
            /// This starts the HTTP request but does NOT wait for the response.
            /// Returns the FutureIncomingResponse which can be polled.
            fn prepare_streaming_request<T: Into<Bytes>>(
                &self,
                req: Request<T>,
            ) -> RigResult<wasi_http::types::FutureIncomingResponse> {
                let (parts, body) = req.into_parts();
                let body_bytes: Bytes = body.into();
                let url = parts.uri.to_string();

                let (scheme, authority, path) = Self::parse_url(&url)?;

                // Create WASI headers
                let fields = Fields::new();
                for (name, value) in parts.headers.iter() {
                    let _ = fields.append(&name.to_string(), value.as_bytes());
                }

                // Create request
                let request = OutgoingRequest::new(fields);
                let _ = request.set_method(&Self::convert_method(&parts.method));
                let _ = request.set_scheme(Some(&scheme));
                let _ = request.set_authority(Some(&authority));
                let _ = request.set_path_with_query(Some(&path));

                // Write body if present
                if !body_bytes.is_empty() {
                    let out_body = request
                        .body()
                        .map_err(|_| _wasi_http_instance_error("Failed to get body"))?;
                    let stream = out_body
                        .write()
                        .map_err(|_| _wasi_http_instance_error("Failed to get body stream"))?;

                    stream
                        .blocking_write_and_flush(&body_bytes)
                        .map_err(|e| _wasi_http_instance_error(format!("Write failed: {:?}", e)))?;

                    drop(stream);
                    OutgoingBody::finish(out_body, None).map_err(|e| {
                        _wasi_http_instance_error(format!("Finish failed: {:?}", e))
                    })?;
                }

                // Send request - returns FutureIncomingResponse
                let options = RequestOptions::new();
                let future_response = outgoing_handler::handle(request, Some(options))
                    .map_err(|e| _wasi_http_instance_error(format!("Handle failed: {:?}", e)))?;

                Ok(future_response)
            }
        }

        /// Poll-based async future for streaming HTTP response
        /// This struct implements Future and polls the WASI FutureIncomingResponse
        pub struct WasiStreamingResponseFuture {
            future_response: Option<wasi_http::types::FutureIncomingResponse>,
            resolved: bool,
        }

        impl WasiStreamingResponseFuture {
            fn new(future_response: wasi_http::types::FutureIncomingResponse) -> Self {
                Self {
                    future_response: Some(future_response),
                    resolved: false,
                }
            }
        }

        // WasiStreamingResponseFuture needs Send for rig's trait bounds
        unsafe impl Send for WasiStreamingResponseFuture {}

        impl Future for WasiStreamingResponseFuture {
            type Output = RigResult<(u16, http::HeaderMap, WasiBodyStream)>;

            fn poll(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
                if self.resolved {
                    return Poll::Ready(Err(_wasi_http_instance_error("Already resolved")));
                }

                // First, check if ready (without taking ownership)
                {
                    let future_response = match &self.future_response {
                        Some(f) => f,
                        None => return Poll::Ready(Err(_wasi_http_instance_error("No future"))),
                    };

                    // Check if response is ready using non-blocking ready()
                    let pollable = future_response.subscribe();
                    if !pollable.ready() {
                        // Not ready yet - return Pending so caller can poll again
                        // On iOS, this allows the JS event loop to run and deliver HTTP data
                        return Poll::Pending;
                    }
                }

                // Response is ready - now take ownership
                self.resolved = true;
                let future_response = self.future_response.take().unwrap();

                let response_result = match future_response.get() {
                    Some(Ok(Ok(r))) => r,
                    Some(Ok(Err(e))) => {
                        return Poll::Ready(Err(_wasi_http_instance_error(format!(
                            "HTTP error: {:?}",
                            e
                        ))))
                    }
                    Some(Err(_)) => {
                        return Poll::Ready(Err(_wasi_http_instance_error("Response error")))
                    }
                    None => {
                        return Poll::Ready(Err(_wasi_http_instance_error(
                            "Response not ready after ready()",
                        )))
                    }
                };

                let status = response_result.status();

                // Convert response headers from WASI to http::HeaderMap
                let wasi_headers = response_result.headers();
                let mut headers = http::HeaderMap::new();
                for (name, value) in wasi_headers.entries() {
                    if let Ok(header_name) = http::header::HeaderName::try_from(name.as_str()) {
                        if let Ok(header_value) = http::header::HeaderValue::from_bytes(&value) {
                            headers.insert(header_name, header_value);
                        }
                    }
                }

                // Get stream
                let incoming_body = match response_result.consume() {
                    Ok(b) => b,
                    Err(_) => {
                        return Poll::Ready(Err(_wasi_http_instance_error(
                            "Failed to consume body",
                        )))
                    }
                };

                let stream = match incoming_body.stream() {
                    Ok(s) => s,
                    Err(_) => {
                        return Poll::Ready(Err(_wasi_http_instance_error("Failed to get stream")))
                    }
                };

                Poll::Ready(Ok((
                    status,
                    headers,
                    WasiBodyStream {
                        stream,
                        _body: incoming_body,
                    },
                )))
            }
        }

        /// Helper to create instance errors (internal, prefixed to avoid collisions)
        fn _wasi_http_instance_error<E: std::fmt::Display>(msg: E) -> RigError {
            RigError::Instance(Box::new(_WasiHttpSimpleError(msg.to_string())))
        }

        #[derive(Debug)]
        struct _WasiHttpSimpleError(String);

        impl std::fmt::Display for _WasiHttpSimpleError {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl std::error::Error for _WasiHttpSimpleError {}

        /// Stream adapter for WASI body reading
        pub struct WasiBodyStream {
            stream: InputStream,
            _body: IncomingBody, // Keep body alive while streaming
        }

        // WasiBodyStream needs Send for the streaming interface
        // WASI is single-threaded so this is safe
        unsafe impl Send for WasiBodyStream {}

        impl Stream for WasiBodyStream {
            type Item = RigResult<Bytes>;

            fn poll_next(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
                // Use non-blocking pattern: check ready() first, then read()
                // This works on both JSPI (where block() suspends) and iOS (where block() returns immediately)
                let pollable = self.stream.subscribe();

                if !pollable.ready() {
                    // Not ready yet - return Pending so caller can poll again
                    // On iOS, this allows the JS event loop to run and deliver HTTP data
                    return Poll::Pending;
                }

                // Data is available, do non-blocking read
                match self.stream.read(8192) {
                    Ok(chunk) => {
                        if chunk.is_empty() {
                            // Empty read after ready() means stream is done
                            Poll::Ready(None)
                        } else {
                            Poll::Ready(Some(Ok(Bytes::from(chunk))))
                        }
                    }
                    Err(StreamError::Closed) => Poll::Ready(None),
                    Err(e) => Poll::Ready(Some(Err(_wasi_http_instance_error(format!(
                        "Read error: {:?}",
                        e
                    ))))),
                }
            }
        }

        impl HttpClientExt for WasiHttpClient {
            fn send<T, U>(
                &self,
                req: Request<T>,
            ) -> impl Future<Output = RigResult<Response<LazyBody<U>>>> + WasmCompatSend + 'static
            where
                T: Into<Bytes> + WasmCompatSend,
                U: From<Bytes> + WasmCompatSend + 'static,
            {
                // Execute synchronously - JSPI handles async at JS layer
                let result = self.execute_request(req);

                async move {
                    let (status, body_bytes) = result?;

                    let status_code = http::StatusCode::from_u16(status)
                        .map_err(|e| _wasi_http_instance_error(format!("Invalid status: {}", e)))?;

                    if !status_code.is_success() {
                        let body_text = String::from_utf8_lossy(&body_bytes).to_string();
                        return Err(RigError::InvalidStatusCodeWithMessage(
                            status_code,
                            body_text,
                        ));
                    }

                    // Create lazy body future that's already resolved
                    let lazy_body: LazyBody<U> = Box::pin(async move { Ok(U::from(body_bytes)) });

                    Response::builder()
                        .status(status_code)
                        .body(lazy_body)
                        .map_err(RigError::Protocol)
                }
            }

            fn send_multipart<U>(
                &self,
                req: Request<MultipartForm>,
            ) -> impl Future<Output = RigResult<Response<LazyBody<U>>>> + WasmCompatSend + 'static
            where
                U: From<Bytes> + WasmCompatSend + 'static,
            {
                // For now, convert multipart to bytes and send as regular request
                // This is a simplified implementation - full multipart support would need
                // proper boundary handling
                let (parts, _multipart) = req.into_parts();

                // Create a new request with empty body for now
                // Full multipart support would serialize the form data
                let new_req = Request::from_parts(parts, Bytes::new());
                let result = self.execute_request(new_req);

                async move {
                    let (status, body_bytes) = result?;

                    let status_code = http::StatusCode::from_u16(status)
                        .map_err(|e| _wasi_http_instance_error(format!("Invalid status: {}", e)))?;

                    if !status_code.is_success() {
                        let body_text = String::from_utf8_lossy(&body_bytes).to_string();
                        return Err(RigError::InvalidStatusCodeWithMessage(
                            status_code,
                            body_text,
                        ));
                    }

                    let lazy_body: LazyBody<U> = Box::pin(async move { Ok(U::from(body_bytes)) });

                    Response::builder()
                        .status(status_code)
                        .body(lazy_body)
                        .map_err(RigError::Protocol)
                }
            }

            fn send_streaming<T>(
                &self,
                req: Request<T>,
            ) -> impl Future<Output = RigResult<StreamingResponse>> + WasmCompatSend
            where
                T: Into<Bytes>,
            {
                // Prepare the request (sync) - this starts the HTTP request
                let prepare_result = self.prepare_streaming_request(req);

                async move {
                    // Get the future response from prepare
                    let future_response = prepare_result?;

                    // Use the async polling future to wait for response
                    let (status, headers, wasi_stream) =
                        WasiStreamingResponseFuture::new(future_response).await?;

                    let status_code = http::StatusCode::from_u16(status)
                        .map_err(|e| _wasi_http_instance_error(format!("Invalid status: {}", e)))?;

                    if !status_code.is_success() {
                        // For streaming, we can't easily get the error body
                        return Err(RigError::InvalidStatusCode(status_code));
                    }

                    // Box the stream using rig's BoxedStream type alias
                    let boxed_stream: BoxedStream = Box::pin(wasi_stream);

                    let mut response = Response::builder().status(status_code);

                    if let Some(hs) = response.headers_mut() {
                        *hs = headers;
                    }

                    response.body(boxed_stream).map_err(RigError::Protocol)
                }
            }
        }
    };
}

/// Generate a general-purpose HttpClient implementation using the provided WASI bindings paths.
///
/// This provides a robust HTTP client for non-LLM tasks (like MCP, OAuth, etc.)
/// including streaming support, bearer tokens, and simple helper methods.
///
/// # Arguments
///
/// * `$http_mod` - Path to the http module (e.g., `crate::bindings::wasi::http`)
/// * `$io_mod` - Path to the io module (e.g., `crate::bindings::wasi::io`)
#[macro_export]
macro_rules! define_general_http_client {
    ($http_mod:path, $io_mod:path) => {
        // Create local aliases for the modules
        use $http_mod as wasi_http;
        use $io_mod as wasi_io;

        use wasi_http::{
            outgoing_handler,
            types::{
                Fields, IncomingBody, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme,
            },
        };
        use wasi_io::streams::{InputStream, StreamError};
        use $crate::http_transport::{
            HttpBodyStream as BridgeBodyStreamTrait, HttpError as BridgeHttpError,
            HttpResponse as BridgeHttpResponse, HttpStreamingResponse as BridgeStreamingResponse,
            HttpTransport as BridgeHttpTransport,
        };

        /// HTTP response from a request
        pub struct HttpResponse {
            pub status: u16,
            pub body: Vec<u8>,
        }

        /// Streaming HTTP response
        pub struct HttpStreamingResponse {
            pub status: u16,
            pub stream: HttpBodyStream,
        }

        /// Stream for reading HTTP response body incrementally
        pub struct HttpBodyStream {
            stream: InputStream,
            _body: IncomingBody, // Keep body alive while streaming
        }

        impl HttpBodyStream {
            /// Read next chunk (blocking, returns None when stream ends)
            pub fn read_chunk(&self, max_size: usize) -> Result<Option<Vec<u8>>, HttpError> {
                match self.stream.blocking_read(max_size as u64) {
                    Ok(chunk) => {
                        if chunk.is_empty() {
                            Ok(None)
                        } else {
                            Ok(Some(chunk))
                        }
                    }
                    Err(StreamError::Closed) => Ok(None),
                    Err(e) => Err(HttpError::BodyReadFailed(format!("Read error: {:?}", e))),
                }
            }

            /// Read until a complete line (ending with \n) is found
            /// Returns the line including the newline, or None if stream ends
            pub fn read_line(&self) -> Result<Option<String>, HttpError> {
                let mut buffer = Vec::new();
                loop {
                    match self.stream.blocking_read(1) {
                        Ok(chunk) => {
                            if chunk.is_empty() {
                                // No more data, return what we have
                                if buffer.is_empty() {
                                    return Ok(None);
                                }
                                return Ok(Some(String::from_utf8_lossy(&buffer).to_string()));
                            }
                            buffer.extend_from_slice(&chunk);
                            if chunk[0] == b'\n' {
                                return Ok(Some(String::from_utf8_lossy(&buffer).to_string()));
                            }
                        }
                        Err(StreamError::Closed) => {
                            if buffer.is_empty() {
                                return Ok(None);
                            }
                            return Ok(Some(String::from_utf8_lossy(&buffer).to_string()));
                        }
                        Err(e) => {
                            return Err(HttpError::BodyReadFailed(format!("Read error: {:?}", e)))
                        }
                    }
                }
            }
        }

        /// Errors that can occur during HTTP operations
        #[derive(Debug)]
        pub enum HttpError {
            RequestFailed(String),
            ResponseFailed(String),
            BodyReadFailed(String),
        }

        impl std::fmt::Display for HttpError {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                match self {
                    HttpError::RequestFailed(msg) => write!(f, "Request failed: {}", msg),
                    HttpError::ResponseFailed(msg) => write!(f, "Response failed: {}", msg),
                    HttpError::BodyReadFailed(msg) => write!(f, "Body read failed: {}", msg),
                }
            }
        }

        impl std::error::Error for HttpError {}

        /// WASI HTTP client for making outgoing requests
        #[derive(Clone, Copy)]
        pub struct HttpClient;

        impl HttpClient {
            pub fn new() -> Self {
                Self
            }

            /// Make a simple GET request for JSON
            pub fn get_json(
                url: &str,
                token: Option<&str>,
            ) -> Result<serde_json::Value, HttpError> {
                let mut headers = vec![];
                let auth_val;
                if let Some(t) = token {
                    auth_val = format!("Bearer {}", t);
                    headers.push(("Authorization", auth_val.as_str()));
                }

                let header_slice = if headers.is_empty() {
                    None
                } else {
                    Some(headers.as_slice())
                };

                let response = Self::request(url, Method::Get, header_slice, None, None)?;
                if response.status >= 400 {
                    return Err(HttpError::ResponseFailed(format!(
                        "HTTP {}",
                        response.status
                    )));
                }
                serde_json::from_slice(&response.body)
                    .map_err(|e| HttpError::ResponseFailed(format!("Invalid JSON: {}", e)))
            }

            /// Make a GET request with headers
            pub fn get_json_with_headers(
                url: &str,
                headers: &[(&str, &str)],
            ) -> Result<serde_json::Value, HttpError> {
                let response = Self::request(url, Method::Get, Some(headers), None, None)?;
                if response.status >= 400 {
                    return Err(HttpError::ResponseFailed(format!(
                        "HTTP {}",
                        response.status
                    )));
                }
                serde_json::from_slice(&response.body)
                    .map_err(|e| HttpError::ResponseFailed(format!("Invalid JSON: {}", e)))
            }

            /// Make a POST request with JSON body
            pub fn post_json(
                url: &str,
                body: &serde_json::Value,
                token: Option<&str>,
            ) -> Result<serde_json::Value, HttpError> {
                let body_str = body.to_string();
                let mut headers = vec![("Content-Type", "application/json")];

                // Create a temporary string ownership for the token header value
                let auth_val;
                if let Some(t) = token {
                    auth_val = format!("Bearer {}", t);
                    headers.push(("Authorization", &auth_val));
                }

                let response = Self::request(
                    url,
                    Method::Post,
                    Some(&headers),
                    Some(body_str.into()),
                    None,
                )?;

                if response.status >= 400 {
                    return Err(HttpError::ResponseFailed(format!(
                        "HTTP {}",
                        response.status
                    )));
                }

                serde_json::from_slice(&response.body)
                    .map_err(|e| HttpError::ResponseFailed(format!("Invalid JSON: {}", e)))
            }

            /// Make a POST request with JSON body and get streaming response
            pub fn post_json_streaming(
                url: &str,
                body: &serde_json::Value,
                token: Option<&str>,
            ) -> Result<HttpStreamingResponse, HttpError> {
                let body_str = body.to_string();
                let mut headers = vec![("Content-Type", "application/json")];

                let auth_val;
                if let Some(t) = token {
                    auth_val = format!("Bearer {}", t);
                    headers.push(("Authorization", &auth_val));
                }

                Self::request_streaming(
                    url,
                    Method::Post,
                    Some(&headers),
                    Some(body_str.into()),
                    None,
                )
            }

            /// Make a full HTTP request
            pub fn request(
                url: &str,
                method: Method,
                headers: Option<&[(&str, &str)]>,
                body: Option<Vec<u8>>,
                _options: Option<RequestOptions>,
            ) -> Result<HttpResponse, HttpError> {
                let future = Self::start_request(url, method, headers, body, _options)?;

                // Wait for response
                let pollable = future.subscribe();
                pollable.block();

                let response = future
                    .get()
                    .ok_or_else(|| HttpError::ResponseFailed("No response".to_string()))?
                    .map_err(|_| HttpError::ResponseFailed("Response future error".to_string()))?
                    .map_err(|e| HttpError::ResponseFailed(format!("HTTP error: {:?}", e)))?;

                let status = response.status();

                // Read body
                let incoming_body = response
                    .consume()
                    .map_err(|_| HttpError::ResponseFailed("Failed to consume body".to_string()))?;

                let stream = incoming_body
                    .stream()
                    .map_err(|_| HttpError::ResponseFailed("Failed to get stream".to_string()))?;

                let mut result = Vec::new();
                loop {
                    match stream.blocking_read(64 * 1024) {
                        Ok(chunk) => {
                            if chunk.is_empty() {
                                break;
                            }
                            result.extend_from_slice(&chunk);
                        }
                        Err(StreamError::Closed) => break,
                        Err(e) => {
                            return Err(HttpError::BodyReadFailed(format!("Read error: {:?}", e)));
                        }
                    }
                }

                Ok(HttpResponse {
                    status,
                    body: result,
                })
            }

            /// Make a streaming HTTP request
            pub fn request_streaming(
                url: &str,
                method: Method,
                headers: Option<&[(&str, &str)]>,
                body: Option<Vec<u8>>,
                _options: Option<RequestOptions>,
            ) -> Result<HttpStreamingResponse, HttpError> {
                let future = Self::start_request(url, method, headers, body, _options)?;

                // Wait for headers
                let pollable = future.subscribe();
                pollable.block();

                let response = future
                    .get()
                    .ok_or_else(|| HttpError::ResponseFailed("No response".to_string()))?
                    .map_err(|_| HttpError::ResponseFailed("Response future error".to_string()))?
                    .map_err(|e| HttpError::ResponseFailed(format!("HTTP error: {:?}", e)))?;

                let status = response.status();
                let incoming_body = response
                    .consume()
                    .map_err(|_| HttpError::ResponseFailed("Failed to consume body".to_string()))?;

                let stream = incoming_body
                    .stream()
                    .map_err(|_| HttpError::ResponseFailed("Failed to get stream".to_string()))?;

                Ok(HttpStreamingResponse {
                    status,
                    stream: HttpBodyStream {
                        stream,
                        _body: incoming_body,
                    },
                })
            }

            /// Helper to start a request
            fn start_request(
                url: &str,
                method: Method,
                headers: Option<&[(&str, &str)]>,
                body: Option<Vec<u8>>,
                _options: Option<RequestOptions>,
            ) -> Result<wasi_http::types::FutureIncomingResponse, HttpError> {
                let (scheme, authority, path) = Self::parse_url(url)?;

                let fields = Fields::new();
                if let Some(hdrs) = headers {
                    for (k, v) in hdrs {
                        let _ = fields.append(k, v.as_bytes());
                    }
                }

                let request = OutgoingRequest::new(fields);
                let _ = request.set_method(&method);
                let _ = request.set_scheme(Some(&scheme));
                let _ = request.set_authority(Some(&authority));
                let _ = request.set_path_with_query(Some(&path));

                if let Some(b) = body {
                    let out_body = request
                        .body()
                        .map_err(|_| HttpError::RequestFailed("Failed to get body".to_string()))?;
                    let stream = out_body.write().map_err(|_| {
                        HttpError::RequestFailed("Failed to get body stream".to_string())
                    })?;
                    stream.blocking_write_and_flush(&b).map_err(|e| {
                        HttpError::RequestFailed(format!("Body write failed: {:?}", e))
                    })?;
                    drop(stream);
                    OutgoingBody::finish(out_body, None).map_err(|e| {
                        HttpError::RequestFailed(format!("Body finish failed: {:?}", e))
                    })?;
                }

                let options = RequestOptions::new();
                let future = outgoing_handler::handle(request, Some(options))
                    .map_err(|e| HttpError::RequestFailed(format!("Handle failed: {:?}", e)))?;

                Ok(future)
            }

            /// Supports http://, https://, and custom schemes like wasm://
            fn parse_url(url: &str) -> Result<(Scheme, String, String), HttpError> {
                // Find :// to extract scheme
                let scheme_end = url.find("://").ok_or_else(|| {
                    HttpError::RequestFailed("Invalid URL: missing ://".to_string())
                })?;
                let scheme_str = &url[..scheme_end];
                let rest = &url[scheme_end + 3..];

                let scheme = match scheme_str {
                    "https" => Scheme::Https,
                    "http" => Scheme::Http,
                    other => Scheme::Other(other.to_string()),
                };

                let (authority, path) = if let Some(slash_pos) = rest.find('/') {
                    (rest[..slash_pos].to_string(), rest[slash_pos..].to_string())
                } else {
                    (rest.to_string(), "/".to_string())
                };

                Ok((scheme, authority, path))
            }
        }

        impl BridgeBodyStreamTrait for HttpBodyStream {
            fn read_chunk(&mut self, max_size: usize) -> Result<Option<Vec<u8>>, BridgeHttpError> {
                self.read_chunk(max_size)
                    .map_err(|e| BridgeHttpError::BodyReadFailed(e.to_string()))
            }

            fn read_line(&mut self) -> Result<Option<String>, BridgeHttpError> {
                self.read_line()
                    .map_err(|e| BridgeHttpError::BodyReadFailed(e.to_string()))
            }
        }

        impl BridgeHttpTransport for HttpClient {
            fn get(
                &self,
                url: &str,
                headers: &[(&str, &str)],
            ) -> Result<BridgeHttpResponse, BridgeHttpError> {
                let res = Self::request(url, Method::Get, Some(headers), None, None)
                    .map_err(|e| BridgeHttpError::SendFailed(e.to_string()))?;
                Ok(BridgeHttpResponse {
                    status: res.status,
                    body: res.body,
                })
            }

            fn post(
                &self,
                url: &str,
                headers: &[(&str, &str)],
                body: &[u8],
            ) -> Result<BridgeHttpResponse, BridgeHttpError> {
                // Ensure body is Vec<u8> (owned) for request
                let res =
                    Self::request(url, Method::Post, Some(headers), Some(body.to_vec()), None)
                        .map_err(|e| BridgeHttpError::SendFailed(e.to_string()))?;
                Ok(BridgeHttpResponse {
                    status: res.status,
                    body: res.body,
                })
            }

            fn post_streaming(
                &self,
                url: &str,
                headers: &[(&str, &str)],
                body: &[u8],
            ) -> Result<BridgeStreamingResponse<Box<dyn BridgeBodyStreamTrait>>, BridgeHttpError>
            {
                let res = Self::request_streaming(
                    url,
                    Method::Post,
                    Some(headers),
                    Some(body.to_vec()),
                    None,
                )
                .map_err(|e| BridgeHttpError::SendFailed(e.to_string()))?;

                Ok(BridgeStreamingResponse {
                    status: res.status,
                    stream: Box::new(res.stream),
                })
            }
        }
    };
}
