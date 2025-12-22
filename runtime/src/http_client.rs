//! HTTP Client using WASI HTTP outgoing-handler
//!
//! Provides a synchronous fetch function for use within QuickJS.
//! Uses the standard WASI HTTP interface which maps to JavaScript XMLHttpRequest shim.

use crate::bindings::wasi::http::{
    outgoing_handler,
    types::{Fields, Method, OutgoingRequest, Scheme},
};

/// Response from a fetch operation
pub struct FetchResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
}

/// Parse a URL into scheme, authority, and path components
fn parse_url(url: &str) -> Result<(Scheme, String, String), String> {
    // Handle scheme
    let (scheme, rest) = if url.starts_with("https://") {
        (Scheme::Https, &url[8..])
    } else if url.starts_with("http://") {
        (Scheme::Http, &url[7..])
    } else {
        return Err(format!("Unsupported URL scheme: {}", url));
    };

    // Split authority and path
    let (authority, path) = match rest.find('/') {
        Some(idx) => (rest[..idx].to_string(), rest[idx..].to_string()),
        None => (rest.to_string(), "/".to_string()),
    };

    if authority.is_empty() {
        return Err("URL has no authority (host)".to_string());
    }

    Ok((scheme, authority, path))
}

/// Read the entire body from an IncomingBody stream
fn read_body(
    body: crate::bindings::wasi::http::types::IncomingBody,
) -> Result<String, String> {
    let stream = body.stream().map_err(|_| "Failed to get body stream")?;

    let mut bytes = Vec::new();
    loop {
        match stream.blocking_read(65536) {
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
    
    String::from_utf8(bytes).map_err(|e| format!("Body is not valid UTF-8: {}", e))
}

/// Perform a synchronous HTTP GET request
pub fn fetch_sync(url: &str) -> Result<FetchResponse, String> {
    let (scheme, authority, path) = parse_url(url)?;

    // Build headers
    let headers = Fields::new();

    // Build request
    let request = OutgoingRequest::new(headers);
    request.set_method(&Method::Get).map_err(|_| "Failed to set method")?;
    request.set_scheme(Some(&scheme)).map_err(|_| "Failed to set scheme")?;
    request.set_authority(Some(&authority)).map_err(|_| "Failed to set authority")?;
    request.set_path_with_query(Some(&path)).map_err(|_| "Failed to set path")?;

    // Send request
    let future_response = outgoing_handler::handle(request, None)
        .map_err(|e| format!("HTTP request failed: {:?}", e))?;

    // Wait for response (our shim resolves synchronously)
    loop {
        if let Some(result) = future_response.get() {
            let response = result.map_err(|_| "Response error")?
                                 .map_err(|e| format!("HTTP error: {:?}", e))?;

            let status = response.status();
            let ok = status >= 200 && status < 300;

            // Read body
            let body_handle = response.consume().map_err(|_| "Failed to consume response body")?;
            let body = read_body(body_handle)?;

            return Ok(FetchResponse { status, ok, body });
        }
    }
}

/// Perform a synchronous HTTP request with custom method, headers, body
pub fn fetch_request(
    method: &str,
    url: &str,
    headers_json: Option<&str>,
    body: Option<&str>,
) -> Result<FetchResponse, String> {
    let (scheme, authority, path) = parse_url(url)?;

    // Build headers
    let headers = Fields::new();
    
    // Parse JSON headers if provided
    if let Some(headers_str) = headers_json {
        // Simple JSON parsing for {"key": "value", ...}
        // This is a basic parser since we don't have serde
        for pair in headers_str.trim_matches(|c| c == '{' || c == '}').split(',') {
            let parts: Vec<&str> = pair.splitn(2, ':').collect();
            if parts.len() == 2 {
                let key = parts[0].trim().trim_matches('"');
                let value = parts[1].trim().trim_matches('"');
                if !key.is_empty() && !value.is_empty() {
                    let _ = headers.append(
                        &key.to_string(),
                        &value.as_bytes().to_vec(),
                    );
                }
            }
        }
    }

    // Build request
    let request = OutgoingRequest::new(headers);
    
    // Set method
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
    request.set_method(&method_enum).map_err(|_| "Failed to set method")?;
    request.set_scheme(Some(&scheme)).map_err(|_| "Failed to set scheme")?;
    request.set_authority(Some(&authority)).map_err(|_| "Failed to set authority")?;
    request.set_path_with_query(Some(&path)).map_err(|_| "Failed to set path")?;

    // Write body if provided
    if let Some(_body_str) = body {
        // Note: For now we only support GET-style requests
        // Full body support would require writing to the OutgoingBody stream
        // This matches the previous browser-http behavior
    }

    // Send request
    let future_response = outgoing_handler::handle(request, None)
        .map_err(|e| format!("HTTP request failed: {:?}", e))?;

    // Wait for response (our shim resolves synchronously)
    loop {
        if let Some(result) = future_response.get() {
            let response = result.map_err(|_| "Response error")?
                                 .map_err(|e| format!("HTTP error: {:?}", e))?;

            let status = response.status();
            let ok = status >= 200 && status < 300;

            // Read body
            let body_handle = response.consume().map_err(|_| "Failed to consume response body")?;
            let response_body = read_body(body_handle)?;

            return Ok(FetchResponse { 
                status, 
                ok, 
                body: response_body,
            });
        }
    }
}
