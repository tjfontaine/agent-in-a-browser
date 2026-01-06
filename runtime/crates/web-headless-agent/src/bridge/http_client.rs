//! Simple HTTP Client for MCP calls
//!
//! Uses WASI HTTP bindings directly for JSON-RPC over HTTP.

use crate::bindings::wasi::http::{
    outgoing_handler,
    types::{Fields, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme},
};
use crate::bindings::wasi::io::streams::StreamError;

/// HTTP response
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// HTTP error
#[derive(Debug, Clone)]
pub enum HttpError {
    RequestFailed(String),
    ResponseError(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::RequestFailed(e) => write!(f, "Request failed: {}", e),
            HttpError::ResponseError(e) => write!(f, "Response error: {}", e),
        }
    }
}

impl std::error::Error for HttpError {}

/// Simple HTTP client for MCP JSON-RPC calls
pub struct HttpClient;

impl HttpClient {
    /// Make a POST request with JSON body
    pub fn post_json(
        url: &str,
        auth_header: Option<&str>,
        body: &str,
    ) -> Result<HttpResponse, HttpError> {
        let (scheme, authority, path) = Self::parse_url(url)?;

        let fields = Fields::new();
        let _ = fields.append("content-type", b"application/json");
        if let Some(auth) = auth_header {
            let _ = fields.append("authorization", auth.as_bytes());
        }

        let request = OutgoingRequest::new(fields);
        let _ = request.set_method(&Method::Post);
        let _ = request.set_scheme(Some(&scheme));
        let _ = request.set_authority(Some(&authority));
        let _ = request.set_path_with_query(Some(&path));

        // Write body
        let out_body = request
            .body()
            .map_err(|_| HttpError::RequestFailed("Failed to get body".to_string()))?;
        let stream = out_body
            .write()
            .map_err(|_| HttpError::RequestFailed("Failed to get body stream".to_string()))?;

        stream
            .blocking_write_and_flush(body.as_bytes())
            .map_err(|e| HttpError::RequestFailed(format!("Write failed: {:?}", e)))?;

        drop(stream);
        OutgoingBody::finish(out_body, None)
            .map_err(|e| HttpError::RequestFailed(format!("Finish failed: {:?}", e)))?;

        // Send request
        let options = RequestOptions::new();
        let future_response = outgoing_handler::handle(request, Some(options))
            .map_err(|e| HttpError::RequestFailed(format!("Handle failed: {:?}", e)))?;

        // Wait for response
        let pollable = future_response.subscribe();
        pollable.block();

        let response = future_response
            .get()
            .ok_or_else(|| HttpError::ResponseError("No response".to_string()))?
            .map_err(|_| HttpError::ResponseError("Response future error".to_string()))?
            .map_err(|e| HttpError::ResponseError(format!("HTTP error: {:?}", e)))?;

        let status = response.status();

        // Read body
        let incoming_body = response
            .consume()
            .map_err(|_| HttpError::ResponseError("Failed to consume body".to_string()))?;

        let stream = incoming_body
            .stream()
            .map_err(|_| HttpError::ResponseError("Failed to get stream".to_string()))?;

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
                    return Err(HttpError::ResponseError(format!("Read error: {:?}", e)));
                }
            }
        }

        Ok(HttpResponse {
            status,
            body: result,
        })
    }

    fn parse_url(url: &str) -> Result<(Scheme, String, String), HttpError> {
        let (scheme_str, rest) = if url.starts_with("https://") {
            ("https", &url[8..])
        } else if url.starts_with("http://") {
            ("http", &url[7..])
        } else {
            return Err(HttpError::RequestFailed("Invalid URL scheme".to_string()));
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
}
