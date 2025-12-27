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

    let (authority, path) = match rest.find('/') {
        Some(idx) => (rest[..idx].to_string(), rest[idx..].to_string()),
        None => (rest.to_string(), "/".to_string()),
    };

    if authority.is_empty() {
        return Err("URL has no authority (host)".to_string());
    }

    Ok((scheme, authority, path))
}

/// Read the entire body from an IncomingBody stream as bytes
fn read_body_bytes(
    body: crate::bindings::wasi::http::types::IncomingBody,
) -> Result<Vec<u8>, String> {
    let stream = body.stream().map_err(|_| "Failed to get body stream")?;

    let mut bytes = Vec::new();
    loop {
        let pollable = stream.subscribe();
        pollable.block();
        
        match stream.read(65536) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    break;
                }
                bytes.extend(chunk);
            }
            Err(_) => break,
        }
    }

    drop(stream);
    Ok(bytes)
}

/// Perform a synchronous HTTP GET request
pub fn fetch_sync(url: &str) -> Result<FetchResponse, String> {
    fetch(Method::Get, url, &[], None)
}

/// Perform a synchronous HTTP request with full control
pub fn fetch(
    method: Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
) -> Result<FetchResponse, String> {
    let (scheme, authority, path) = parse_url(url)?;

    // Build headers
    let header_fields = Fields::new();
    for (key, value) in headers {
        let _ = header_fields.append(&key.to_string(), &value.as_bytes().to_vec());
    }

    // Build request
    let request = OutgoingRequest::new(header_fields);
    request.set_method(&method).map_err(|_| "Failed to set method")?;
    request.set_scheme(Some(&scheme)).map_err(|_| "Failed to set scheme")?;
    request.set_authority(Some(&authority)).map_err(|_| "Failed to set authority")?;
    request.set_path_with_query(Some(&path)).map_err(|_| "Failed to set path")?;

    // Write body if provided
    if let Some(body_bytes) = body {
        let outgoing_body = request.body().map_err(|_| "Failed to get outgoing body")?;
        let stream = outgoing_body.write().map_err(|_| "Failed to get write stream")?;
        
        let mut offset = 0;
        while offset < body_bytes.len() {
            let chunk_size = std::cmp::min(65536, body_bytes.len() - offset);
            let chunk = &body_bytes[offset..offset + chunk_size];
            
            let pollable = stream.subscribe();
            pollable.block();
            
            stream.write(chunk).map_err(|_| "Failed to write body chunk")?;
            offset += chunk_size;
        }
        
        drop(stream);
        crate::bindings::wasi::http::types::OutgoingBody::finish(outgoing_body, None)
            .map_err(|_| "Failed to finish body")?;
    }

    // Send request
    let future_response = outgoing_handler::handle(request, None)
        .map_err(|e| format!("HTTP request failed: {:?}", e))?;

    // Wait for response
    loop {
        if let Some(result) = future_response.get() {
            let response = result.map_err(|_| "Response error")?
                                 .map_err(|e| format!("HTTP error: {:?}", e))?;

            let status = response.status();
            let ok = status >= 200 && status < 300;

            let body_handle = response.consume().map_err(|_| "Failed to consume response body")?;
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
    let mut header_vec = Vec::new();
    if let Some(headers_str) = headers_json {
        for pair in headers_str.trim_matches(|c| c == '{' || c == '}').split(',') {
            let parts: Vec<&str> = pair.splitn(2, ':').collect();
            if parts.len() == 2 {
                let key = parts[0].trim().trim_matches('"');
                let value = parts[1].trim().trim_matches('"');
                if !key.is_empty() && !value.is_empty() {
                    header_vec.push((key, value));
                }
            }
        }
    }

    fetch(
        method_enum,
        url,
        &header_vec,
        body.map(|s| s.as_bytes()),
    )
}
