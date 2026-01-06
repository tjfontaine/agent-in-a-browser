//! HTTP Transport Trait
//!
//! Abstracts HTTP operations so they can be implemented differently by each
//! WASM component using their own WIT bindings.

/// HTTP response from a request
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Streaming HTTP response
pub struct HttpStreamingResponse<S> {
    pub status: u16,
    pub stream: S,
}

/// Error type for HTTP operations
#[derive(Debug, Clone)]
pub enum HttpError {
    /// Failed to create request
    RequestCreationFailed(String),
    /// Failed to send request
    SendFailed(String),
    /// No response received
    NoResponse,
    /// Failed to read body
    BodyReadFailed(String),
    /// Connection error
    ConnectionError(String),
    /// Timeout
    Timeout,
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::RequestCreationFailed(e) => write!(f, "Request creation failed: {}", e),
            HttpError::SendFailed(e) => write!(f, "Send failed: {}", e),
            HttpError::NoResponse => write!(f, "No response received"),
            HttpError::BodyReadFailed(e) => write!(f, "Body read failed: {}", e),
            HttpError::ConnectionError(e) => write!(f, "Connection error: {}", e),
            HttpError::Timeout => write!(f, "Request timed out"),
        }
    }
}

impl std::error::Error for HttpError {}

/// HTTP transport trait for making HTTP requests
///
/// This trait abstracts over WIT bindings so shared code can make HTTP
/// requests without depending on specific bindings.
pub trait HttpTransport {
    /// Send a GET request and return the full response
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<HttpResponse, HttpError>;

    /// Send a POST request with a body
    fn post(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<HttpResponse, HttpError>;

    /// Send a POST request and get a streaming response
    fn post_streaming(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<HttpStreamingResponse<Box<dyn HttpBodyStream>>, HttpError>;
}

/// Stream for reading HTTP response body incrementally
pub trait HttpBodyStream {
    /// Read next chunk (blocking, returns None when stream ends)
    fn read_chunk(&mut self, max_size: usize) -> Result<Option<Vec<u8>>, HttpError>;

    /// Read until a complete line (ending with \n) is found
    fn read_line(&mut self) -> Result<Option<String>, HttpError>;
}
