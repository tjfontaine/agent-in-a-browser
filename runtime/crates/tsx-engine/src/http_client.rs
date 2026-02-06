//! HTTP Client using WASI HTTP outgoing-handler
//!
//! Provides synchronous fetch functions for use within the runtime.
//! Uses the standard WASI HTTP interface.

use crate::bindings::wasi::http::{
    outgoing_handler,
    types::{Fields, Method, OutgoingRequest, Scheme},
};

/// Response from a fetch operation
pub struct FetchResponse {
    pub status: u16,
    pub ok: bool,
    /// Raw bytes of response body
    pub bytes: Vec<u8>,
}

impl FetchResponse {
    /// Get body as UTF-8 string (legacy compatibility)
    #[allow(dead_code)]
    pub fn text(&self) -> Result<String, std::string::FromUtf8Error> {
        String::from_utf8(self.bytes.clone())
    }

    /// Get body as string, using lossy conversion for non-UTF8
    pub fn text_lossy(&self) -> String {
        String::from_utf8_lossy(&self.bytes).to_string()
    }
}

// Legacy compatibility - body as string
impl FetchResponse {
    #[allow(dead_code)]
    pub fn body(&self) -> String {
        self.text_lossy()
    }
}

/// Parse a URL into scheme, authority, and path components
fn parse_url(url: &str) -> Result<(Scheme, String, String), String> {
    let (scheme, rest) = if url.starts_with("https://") {
        (Scheme::Https, &url[8..])
    } else if url.starts_with("http://") {
        (Scheme::Http, &url[7..])
    } else {
        return Err(format!("Unsupported URL scheme: {}", url));
    };

    let split_idx = rest
        .find(|ch| ['/', '?', '#'].contains(&ch))
        .unwrap_or(rest.len());
    let authority = rest[..split_idx].to_string();

    let mut path = if split_idx >= rest.len() {
        "/".to_string()
    } else {
        let tail = &rest[split_idx..];
        if tail.starts_with('/') {
            tail.to_string()
        } else {
            format!("/{}", tail)
        }
    };

    if let Some(fragment_idx) = path.find('#') {
        path.truncate(fragment_idx);
    }
    if path.is_empty() {
        path = "/".to_string();
    }

    if authority.is_empty() {
        return Err("URL has no authority (host)".to_string());
    }

    Ok((scheme, authority, path))
}

fn parse_headers_json(headers_json: Option<&str>) -> Vec<(String, String)> {
    let mut header_vec = Vec::new();
    if let Some(headers_str) = headers_json {
        if let Ok(serde_json::Value::Object(map)) =
            serde_json::from_str::<serde_json::Value>(headers_str)
        {
            for (key, value) in map {
                if key.is_empty() {
                    continue;
                }
                let value_str = match value {
                    serde_json::Value::String(s) => s,
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => {
                        if b {
                            "true".to_string()
                        } else {
                            "false".to_string()
                        }
                    }
                    _ => continue,
                };
                if !value_str.is_empty() {
                    header_vec.push((key, value_str));
                }
            }
        }
    }
    header_vec
}

/// Read the entire body from an IncomingBody stream as bytes
fn read_body_bytes(
    body: crate::bindings::wasi::http::types::IncomingBody,
) -> Result<Vec<u8>, String> {
    let stream = body.stream().map_err(|_| "Failed to get body stream")?;

    let mut bytes = Vec::new();
    loop {
        // Use blocking_read for JSPI suspension - this will suspend until data is available
        match stream.blocking_read(65536) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    // Empty chunk after blocking_read means stream ended
                    break;
                }
                bytes.extend(chunk);
            }
            Err(e) => {
                return Err(format!("Failed to read body stream: {:?}", e));
            }
        }
    }

    drop(stream);
    Ok(bytes)
}

/// Perform a synchronous HTTP GET request
pub fn fetch_sync(url: &str) -> Result<FetchResponse, String> {
    fetch(Method::Get, url, &[], None, None)
}

/// Perform a synchronous HTTP request with full control
pub fn fetch(
    method: Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    timeout_ms: Option<u64>,
) -> Result<FetchResponse, String> {
    if let Some(0) = timeout_ms {
        return Err("Request timeout (0ms)".to_string());
    }
    let (scheme, authority, path) = parse_url(url)?;

    // Build headers
    let header_fields = Fields::new();
    for (key, value) in headers {
        let _ = header_fields.append(&key.to_string(), &value.as_bytes().to_vec());
    }

    // Build request
    let request = OutgoingRequest::new(header_fields);
    request
        .set_method(&method)
        .map_err(|_| "Failed to set method")?;
    request
        .set_scheme(Some(&scheme))
        .map_err(|_| "Failed to set scheme")?;
    request
        .set_authority(Some(&authority))
        .map_err(|_| "Failed to set authority")?;
    request
        .set_path_with_query(Some(&path))
        .map_err(|_| "Failed to set path")?;

    // Write body if provided
    if let Some(body_bytes) = body {
        let outgoing_body = request.body().map_err(|_| "Failed to get outgoing body")?;
        let stream = outgoing_body
            .write()
            .map_err(|_| "Failed to get write stream")?;

        let mut offset = 0;
        while offset < body_bytes.len() {
            let chunk_size = std::cmp::min(65536, body_bytes.len() - offset);
            let chunk = &body_bytes[offset..offset + chunk_size];

            let pollable = stream.subscribe();
            pollable.block();

            stream
                .write(chunk)
                .map_err(|_| "Failed to write body chunk")?;
            offset += chunk_size;
        }

        drop(stream);
        crate::bindings::wasi::http::types::OutgoingBody::finish(outgoing_body, None)
            .map_err(|_| "Failed to finish body")?;
    }

    // Send request
    let future_response = outgoing_handler::handle(request, None)
        .map_err(|e| format!("HTTP request failed: {:?}", e))?;

    // Wait for response - use block() to allow JSPI suspension
    let start = std::time::Instant::now();
    loop {
        if let Some(max_ms) = timeout_ms {
            if start.elapsed().as_millis() as u64 > max_ms {
                return Err(format!("Request timeout after {}ms", max_ms));
            }
        }
        // Subscribe to the future and block until ready
        let pollable = future_response.subscribe();
        pollable.block();

        if let Some(result) = future_response.get() {
            let response = result
                .map_err(|_| "Response error")?
                .map_err(|e| format!("HTTP error: {:?}", e))?;

            let status = response.status();
            let ok = status >= 200 && status < 300;

            let body_handle = response
                .consume()
                .map_err(|_| "Failed to consume response body")?;
            let bytes = read_body_bytes(body_handle)?;

            return Ok(FetchResponse { status, ok, bytes });
        }
    }
}

/// Convenience: POST request with JSON headers string (legacy compatibility)
pub fn fetch_request(
    method: &str,
    url: &str,
    headers_json: Option<&str>,
    body: Option<&str>,
    timeout_ms: Option<u64>,
) -> Result<FetchResponse, String> {
    // Parse method
    let method_enum = match method.to_uppercase().as_str() {
        "GET" => Method::Get,
        "HEAD" => Method::Head,
        "POST" => Method::Post,
        "PUT" => Method::Put,
        "DELETE" => Method::Delete,
        "OPTIONS" => Method::Options,
        "TRACE" => Method::Trace,
        "PATCH" => Method::Patch,
        _ => Method::Other(method.to_string()),
    };

    // Parse JSON headers
    let header_vec = parse_headers_json(headers_json);

    let borrowed_headers: Vec<(&str, &str)> = header_vec
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    fetch(
        method_enum,
        url,
        &borrowed_headers,
        body.map(|s| s.as_bytes()),
        timeout_ms,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_url_with_query_and_no_explicit_path() {
        let (_, authority, path) = parse_url("https://example.com?x=1&y=2").unwrap();
        assert_eq!(authority, "example.com");
        assert_eq!(path, "/?x=1&y=2");
    }

    #[test]
    fn test_parse_url_strips_fragment() {
        let (_, authority, path) = parse_url("https://example.com/api?q=1#frag").unwrap();
        assert_eq!(authority, "example.com");
        assert_eq!(path, "/api?q=1");
    }

    #[test]
    fn test_parse_url_requires_supported_scheme() {
        let err = parse_url("ftp://example.com/file").unwrap_err();
        assert!(err.contains("Unsupported URL scheme"), "Got: {}", err);
    }

    #[test]
    fn test_parse_headers_json_preserves_complex_values() {
        let headers = parse_headers_json(Some(
            r#"{"Authorization":"Bearer a:b,c","X-Flag":true,"X-Retry":3}"#,
        ));
        assert!(headers.contains(&(
            "Authorization".to_string(),
            "Bearer a:b,c".to_string()
        )));
        assert!(headers.contains(&("X-Flag".to_string(), "true".to_string())));
        assert!(headers.contains(&("X-Retry".to_string(), "3".to_string())));
    }

    #[test]
    fn test_parse_headers_json_ignores_non_scalar_values() {
        let headers = parse_headers_json(Some(
            r#"{"X-Obj":{"a":1},"X-Arr":[1,2],"X-Ok":"value"}"#,
        ));
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0], ("X-Ok".to_string(), "value".to_string()));
    }
}
