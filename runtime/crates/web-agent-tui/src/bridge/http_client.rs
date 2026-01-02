//! WASI HTTP Client
//!
//! Wraps WASI HTTP outgoing-handler for making HTTP requests.
//! Used for both LLM API calls and MCP communication.

use crate::bindings::wasi::http::{
    outgoing_handler,
    types::{
        Fields, IncomingBody, IncomingResponse, Method, OutgoingBody, OutgoingRequest,
        RequestOptions, Scheme,
    },
};
use crate::bindings::wasi::io::streams::{InputStream, StreamError};

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
                Err(e) => return Err(HttpError::BodyReadFailed(format!("Read error: {:?}", e))),
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
pub struct HttpClient;

impl HttpClient {
    /// Make an HTTP request
    ///
    /// # Arguments
    /// * `method` - HTTP method (GET, POST, etc.)
    /// * `url` - Full URL (e.g., "https://api.openai.com/v1/chat/completions")
    /// * `headers` - Request headers as (name, value) pairs
    /// * `body` - Optional request body
    ///
    /// # Returns
    /// HttpResponse with status and body
    pub fn request(
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<HttpResponse, HttpError> {
        // Parse URL
        let (scheme, authority, path) = parse_url(url)?;

        // Create headers
        let fields = Fields::new();
        for (name, value) in headers {
            fields
                .append(&name.to_string(), value.as_bytes())
                .map_err(|e| HttpError::RequestFailed(format!("Header append failed: {:?}", e)))?;
        }

        // Create request
        let request = OutgoingRequest::new(fields);
        request
            .set_method(&string_to_method(method))
            .map_err(|_| HttpError::RequestFailed("Invalid method".into()))?;
        request
            .set_scheme(Some(&scheme))
            .map_err(|_| HttpError::RequestFailed("Invalid scheme".into()))?;
        request
            .set_authority(Some(&authority))
            .map_err(|_| HttpError::RequestFailed("Invalid authority".into()))?;
        request
            .set_path_with_query(Some(&path))
            .map_err(|_| HttpError::RequestFailed("Invalid path".into()))?;

        // Write body if present
        if let Some(body_bytes) = body {
            let out_body = request
                .body()
                .map_err(|_| HttpError::RequestFailed("Failed to get body".into()))?;
            let stream = out_body
                .write()
                .map_err(|_| HttpError::RequestFailed("Failed to get body stream".into()))?;

            stream
                .blocking_write_and_flush(body_bytes)
                .map_err(|e| HttpError::RequestFailed(format!("Write failed: {:?}", e)))?;

            drop(stream);
            OutgoingBody::finish(out_body, None)
                .map_err(|e| HttpError::RequestFailed(format!("Finish failed: {:?}", e)))?;
        }

        // Send request
        let options = RequestOptions::new();
        let future_response = outgoing_handler::handle(request, Some(options))
            .map_err(|e| HttpError::RequestFailed(format!("Handle failed: {:?}", e)))?;

        // Wait for response
        let pollable = future_response.subscribe();
        pollable.block();

        let response_result = future_response
            .get()
            .ok_or_else(|| HttpError::ResponseFailed("No response".into()))?
            .map_err(|_| HttpError::ResponseFailed("Response error".into()))?
            .map_err(|e| HttpError::ResponseFailed(format!("HTTP error: {:?}", e)))?;

        // Read response
        let status = response_result.status();
        let body = read_response_body(response_result)?;

        Ok(HttpResponse { status, body })
    }

    /// Make a POST request with JSON body
    pub fn post_json(
        url: &str,
        api_key: Option<&str>,
        json_body: &str,
    ) -> Result<HttpResponse, HttpError> {
        let mut headers = vec![
            ("Content-Type", "application/json"),
            ("Accept", "application/json"),
        ];

        let auth_header;
        if let Some(key) = api_key {
            auth_header = format!("Bearer {}", key);
            headers.push(("Authorization", &auth_header));
        }

        Self::request("POST", url, &headers, Some(json_body.as_bytes()))
    }

    /// Make a streaming HTTP request - returns response with body stream
    ///
    /// Use this for Server-Sent Events (SSE) or chunked responses where
    /// you want to process the body incrementally.
    pub fn request_streaming(
        method: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<HttpStreamingResponse, HttpError> {
        // Parse URL
        let (scheme, authority, path) = parse_url(url)?;

        // Create headers
        let fields = Fields::new();
        for (name, value) in headers {
            fields
                .append(&name.to_string(), value.as_bytes())
                .map_err(|e| HttpError::RequestFailed(format!("Header append failed: {:?}", e)))?;
        }

        // Create request
        let request = OutgoingRequest::new(fields);
        request
            .set_method(&string_to_method(method))
            .map_err(|_| HttpError::RequestFailed("Invalid method".into()))?;
        request
            .set_scheme(Some(&scheme))
            .map_err(|_| HttpError::RequestFailed("Invalid scheme".into()))?;
        request
            .set_authority(Some(&authority))
            .map_err(|_| HttpError::RequestFailed("Invalid authority".into()))?;
        request
            .set_path_with_query(Some(&path))
            .map_err(|_| HttpError::RequestFailed("Invalid path".into()))?;

        // Write body if present
        if let Some(body_bytes) = body {
            let out_body = request
                .body()
                .map_err(|_| HttpError::RequestFailed("Failed to get body".into()))?;
            let stream = out_body
                .write()
                .map_err(|_| HttpError::RequestFailed("Failed to get body stream".into()))?;

            stream
                .blocking_write_and_flush(body_bytes)
                .map_err(|e| HttpError::RequestFailed(format!("Write failed: {:?}", e)))?;

            drop(stream);
            OutgoingBody::finish(out_body, None)
                .map_err(|e| HttpError::RequestFailed(format!("Finish failed: {:?}", e)))?;
        }

        // Send request
        let options = RequestOptions::new();
        let future_response = outgoing_handler::handle(request, Some(options))
            .map_err(|e| HttpError::RequestFailed(format!("Handle failed: {:?}", e)))?;

        // Wait for response
        let pollable = future_response.subscribe();
        pollable.block();

        let response_result = future_response
            .get()
            .ok_or_else(|| HttpError::ResponseFailed("No response".into()))?
            .map_err(|_| HttpError::ResponseFailed("Response error".into()))?
            .map_err(|e| HttpError::ResponseFailed(format!("HTTP error: {:?}", e)))?;

        // Get status and body stream (don't read full body)
        let status = response_result.status();
        let incoming_body = response_result
            .consume()
            .map_err(|_| HttpError::BodyReadFailed("Failed to consume body".into()))?;

        let stream = incoming_body
            .stream()
            .map_err(|_| HttpError::BodyReadFailed("Failed to get stream".into()))?;

        Ok(HttpStreamingResponse {
            status,
            stream: HttpBodyStream {
                stream,
                _body: incoming_body,
            },
        })
    }

    /// Make a streaming POST request with JSON body (for SSE/streaming APIs)
    pub fn post_json_streaming(
        url: &str,
        api_key: Option<&str>,
        json_body: &str,
    ) -> Result<HttpStreamingResponse, HttpError> {
        let mut headers = vec![
            ("Content-Type", "application/json"),
            ("Accept", "text/event-stream"), // Request SSE format
        ];

        let auth_header;
        if let Some(key) = api_key {
            auth_header = format!("Bearer {}", key);
            headers.push(("Authorization", &auth_header));
        }

        Self::request_streaming("POST", url, &headers, Some(json_body.as_bytes()))
    }

    /// Make a GET request with optional authorization (for fetching JSON APIs)
    pub fn get_json(url: &str, api_key: Option<&str>) -> Result<HttpResponse, HttpError> {
        let mut headers = vec![("Accept", "application/json")];

        let auth_header;
        if let Some(key) = api_key {
            auth_header = format!("Bearer {}", key);
            headers.push(("Authorization", &auth_header));
        }

        Self::request("GET", url, &headers, None)
    }

    /// Make a GET request with custom headers (for Anthropic which uses x-api-key)
    pub fn get_json_with_headers(
        url: &str,
        extra_headers: &[(&str, &str)],
    ) -> Result<HttpResponse, HttpError> {
        let mut headers = vec![("Accept", "application/json")];
        headers.extend_from_slice(extra_headers);

        Self::request("GET", url, &headers, None)
    }
}

/// Parse URL into (scheme, authority, path)
fn parse_url(url: &str) -> Result<(Scheme, String, String), HttpError> {
    let (scheme_str, rest) = if url.starts_with("https://") {
        ("https", &url[8..])
    } else if url.starts_with("http://") {
        ("http", &url[7..])
    } else {
        return Err(HttpError::RequestFailed("Invalid URL scheme".into()));
    };

    let scheme = if scheme_str == "https" {
        Scheme::Https
    } else {
        Scheme::Http
    };

    let (authority, path) = if let Some(slash_pos) = rest.find('/') {
        (rest[..slash_pos].to_string(), rest[slash_pos..].to_string())
    } else {
        (rest.to_string(), "/".to_string())
    };

    Ok((scheme, authority, path))
}

/// Convert string method to WASI Method enum
fn string_to_method(method: &str) -> Method {
    match method.to_uppercase().as_str() {
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

/// Read the full body from an incoming response
fn read_response_body(response: IncomingResponse) -> Result<Vec<u8>, HttpError> {
    let body = response
        .consume()
        .map_err(|_| HttpError::BodyReadFailed("Failed to consume body".into()))?;

    let stream = body
        .stream()
        .map_err(|_| HttpError::BodyReadFailed("Failed to get stream".into()))?;

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

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_url_https() {
        let (scheme, authority, path) = parse_url("https://api.openai.com/v1/chat").unwrap();
        assert!(matches!(scheme, Scheme::Https));
        assert_eq!(authority, "api.openai.com");
        assert_eq!(path, "/v1/chat");
    }

    #[test]
    fn test_parse_url_http() {
        let (scheme, authority, path) = parse_url("http://localhost:3000/mcp/message").unwrap();
        assert!(matches!(scheme, Scheme::Http));
        assert_eq!(authority, "localhost:3000");
        assert_eq!(path, "/mcp/message");
    }
}
