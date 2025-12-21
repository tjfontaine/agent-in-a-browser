//! HTTP Client using custom browser-http interface
//!
//! Provides a synchronous fetch function for use within QuickJS.
//! Uses the browser-http WIT interface which maps to JavaScript XMLHttpRequest.

use crate::bindings::mcp::ts_runtime::browser_http;

/// Perform a synchronous HTTP GET request
pub fn fetch_sync(url: &str) -> Result<FetchResponse, String> {
    eprintln!("[http_client] fetch_sync: {}", url);
    
    // Call the browser-http interface
    let result_json = browser_http::http_get(url);
    eprintln!("[http_client] Got result: {}", &result_json[..result_json.len().min(200)]);
    
    // Parse the JSON response
    parse_response(&result_json)
}

/// Perform a synchronous HTTP request with custom method, headers, body
pub fn fetch_request(
    method: &str,
    url: &str,
    headers: Option<&str>,
    body: Option<&str>,
) -> Result<FetchResponse, String> {
    eprintln!("[http_client] fetch_request: {} {}", method, url);
    
    // Call the browser-http interface
    let result_json = browser_http::http_request(
        method,
        url,
        headers.unwrap_or("{}"),
        body.unwrap_or(""),
    );
    eprintln!("[http_client] Got result: {}", &result_json[..result_json.len().min(200)]);
    
    // Parse the JSON response
    parse_response(&result_json)
}

/// Parse the JSON response from browser-http
fn parse_response(json: &str) -> Result<FetchResponse, String> {
    // Parse the JSON manually (we don't have serde in the guest)
    // Format: {"status":200,"ok":true,"body":"..."} or {"status":0,"ok":false,"error":"..."}
    
    // Extract status
    let status = extract_number(json, "\"status\":")
        .ok_or("Failed to parse status")?;
    
    // Extract ok
    let ok = json.contains("\"ok\":true");
    
    // Check for error
    if let Some(error) = extract_string(json, "\"error\":\"") {
        return Err(error);
    }
    
    // Extract body
    let body = extract_string(json, "\"body\":\"")
        .unwrap_or_default();
    
    Ok(FetchResponse { status, ok, body })
}

/// Extract a number value from JSON
fn extract_number(json: &str, key: &str) -> Option<u16> {
    let start = json.find(key)?;
    let value_start = start + key.len();
    let rest = &json[value_start..];
    
    // Find end of number (comma, brace, or end)
    let end = rest.find(|c: char| c == ',' || c == '}' || c == ' ')
        .unwrap_or(rest.len());
    
    rest[..end].trim().parse().ok()
}

/// Extract a string value from JSON
fn extract_string(json: &str, key: &str) -> Option<String> {
    let start = json.find(key)?;
    let value_start = start + key.len();
    let rest = &json[value_start..];
    
    // Find end of string (closing quote, accounting for escapes)
    let mut end = 0;
    let mut escaped = false;
    for (i, c) in rest.chars().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            continue;
        }
        if c == '"' {
            end = i;
            break;
        }
    }
    
    if end > 0 {
        // Unescape common JSON escapes
        let s = &rest[..end];
        Some(s.replace("\\n", "\n")
              .replace("\\r", "\r")
              .replace("\\t", "\t")
              .replace("\\\"", "\"")
              .replace("\\\\", "\\"))
    } else {
        None
    }
}

/// Response from a fetch operation
pub struct FetchResponse {
    pub status: u16,
    pub ok: bool,
    pub body: String,
}
