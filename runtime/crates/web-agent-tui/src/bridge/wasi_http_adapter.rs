//! WASI HTTP Adapter for rig-core
//!
//! Uses the shared macro from agent_bridge to generate the WasiHttpClient
//! implementation using this component's WIT bindings.

// Generate WasiHttpClient using our component's bindings
// We must pass the full path to the http and io modules separately to satisfy the macro
agent_bridge::define_wasi_http_client!(crate::bindings::wasi::http, crate::bindings::wasi::io);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_url_https() {
        use crate::bindings::wasi::http::types::Scheme;
        let (scheme, authority, path) =
            WasiHttpClient::parse_url("https://api.anthropic.com/v1/messages").unwrap();
        assert!(matches!(scheme, Scheme::Https));
        assert_eq!(authority, "api.anthropic.com");
        assert_eq!(path, "/v1/messages");
    }

    #[test]
    fn test_parse_url_http() {
        use crate::bindings::wasi::http::types::Scheme;
        let (scheme, authority, path) =
            WasiHttpClient::parse_url("http://localhost:3000/api").unwrap();
        assert!(matches!(scheme, Scheme::Http));
        assert_eq!(authority, "localhost:3000");
        assert_eq!(path, "/api");
    }
}
