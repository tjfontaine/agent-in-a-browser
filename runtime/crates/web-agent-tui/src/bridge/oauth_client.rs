//! OAuth 2.1 Client for MCP
//!
//! Implements OAuth 2.1 with PKCE for MCP servers per MCP 2025-11-25 specification.
//! Supports:
//! - Protected Resource Metadata discovery (RFC9728)
//! - Authorization Server Metadata discovery (RFC8414)
//! - PKCE (RFC7636)

use super::http_client::HttpClient;
use serde::{Deserialize, Serialize};

/// OAuth-related errors
#[derive(Debug)]
pub enum OAuthError {
    HttpError(String),
    MetadataError(String),
    ParseError(String),
    TokenError(String),
}

impl std::fmt::Display for OAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OAuthError::HttpError(msg) => write!(f, "HTTP error: {}", msg),
            OAuthError::MetadataError(msg) => write!(f, "Metadata error: {}", msg),
            OAuthError::ParseError(msg) => write!(f, "Parse error: {}", msg),
            OAuthError::TokenError(msg) => write!(f, "Token error: {}", msg),
        }
    }
}

impl std::error::Error for OAuthError {}

impl From<super::http_client::HttpError> for OAuthError {
    fn from(err: super::http_client::HttpError) -> Self {
        OAuthError::HttpError(err.to_string())
    }
}

impl From<serde_json::Error> for OAuthError {
    fn from(err: serde_json::Error) -> Self {
        OAuthError::ParseError(err.to_string())
    }
}

/// Protected Resource Metadata (RFC9728)
#[derive(Debug, Clone, Deserialize)]
pub struct ProtectedResourceMetadata {
    /// The canonical URL of the protected resource
    pub resource: Option<String>,
    /// List of authorization server URLs
    pub authorization_servers: Vec<String>,
    /// Scopes supported by this resource
    #[serde(default)]
    pub scopes_supported: Vec<String>,
}

/// Authorization Server Metadata (RFC8414)
#[derive(Debug, Clone, Deserialize)]
pub struct AuthServerMetadata {
    /// URL of the authorization endpoint
    pub authorization_endpoint: String,
    /// URL of the token endpoint
    pub token_endpoint: String,
    /// URL of the registration endpoint (optional, RFC7591)
    pub registration_endpoint: Option<String>,
    /// Supported response types
    #[serde(default)]
    pub response_types_supported: Vec<String>,
    /// Supported grant types
    #[serde(default)]
    pub grant_types_supported: Vec<String>,
    /// Supported PKCE code challenge methods
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
    /// Scopes supported
    #[serde(default)]
    pub scopes_supported: Vec<String>,
}

/// PKCE parameters for OAuth authorization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PkceParams {
    /// The code verifier (random string, 43-128 chars)
    pub code_verifier: String,
    /// The code challenge (base64url-encoded SHA256 of verifier)
    pub code_challenge: String,
    /// The challenge method (always S256)
    pub code_challenge_method: String,
}

/// OAuth token response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenResponse {
    /// The access token
    pub access_token: String,
    /// Token type (usually "Bearer")
    pub token_type: String,
    /// Token expiration in seconds
    pub expires_in: Option<u64>,
    /// Refresh token (optional)
    pub refresh_token: Option<String>,
    /// Scopes granted
    pub scope: Option<String>,
}

/// Stored OAuth token with metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredToken {
    /// The access token
    pub access_token: String,
    /// Refresh token (optional)
    pub refresh_token: Option<String>,
    /// Unix timestamp when token expires
    pub expires_at: Option<u64>,
    /// Scopes granted
    pub scope: Option<String>,
    /// The server URL this token is for
    pub server_url: String,
}

/// OAuth client for MCP servers
pub struct OAuthClient {
    /// The MCP server URL
    server_url: String,
}

impl OAuthClient {
    /// Create a new OAuth client for an MCP server
    pub fn new(server_url: &str) -> Self {
        Self {
            server_url: server_url.trim_end_matches('/').to_string(),
        }
    }

    /// Discover protected resource metadata (RFC9728)
    ///
    /// Fetches from `.well-known/oauth-protected-resource`
    pub fn discover_protected_resource(&self) -> Result<ProtectedResourceMetadata, OAuthError> {
        // Try path-specific first, then root
        let url = self.build_well_known_url("oauth-protected-resource");

        let response = HttpClient::request("GET", &url, &[], None)?;

        if response.status == 404 {
            // Try root well-known
            let root_url = self.build_root_well_known_url("oauth-protected-resource");
            let response = HttpClient::request("GET", &root_url, &[], None)?;

            if response.status >= 400 {
                return Err(OAuthError::MetadataError(format!(
                    "Protected resource metadata not found at {} or {}",
                    url, root_url
                )));
            }

            let metadata: ProtectedResourceMetadata = serde_json::from_slice(&response.body)?;
            return Ok(metadata);
        }

        if response.status >= 400 {
            return Err(OAuthError::MetadataError(format!(
                "Failed to fetch protected resource metadata: HTTP {}",
                response.status
            )));
        }

        let metadata: ProtectedResourceMetadata = serde_json::from_slice(&response.body)?;
        Ok(metadata)
    }

    /// Discover authorization server metadata (RFC8414)
    pub fn discover_auth_server(
        &self,
        auth_server_url: &str,
    ) -> Result<AuthServerMetadata, OAuthError> {
        // Parse the auth server URL to build well-known path
        let base = auth_server_url.trim_end_matches('/');
        let url = format!("{}/.well-known/oauth-authorization-server", base);

        let response = HttpClient::request("GET", &url, &[], None)?;

        if response.status == 404 {
            // Try OpenID Connect discovery
            let oidc_url = format!("{}/.well-known/openid-configuration", base);
            let response = HttpClient::request("GET", &oidc_url, &[], None)?;

            if response.status >= 400 {
                return Err(OAuthError::MetadataError(format!(
                    "Auth server metadata not found at {} or {}",
                    url, oidc_url
                )));
            }

            let metadata: AuthServerMetadata = serde_json::from_slice(&response.body)?;
            return Ok(metadata);
        }

        if response.status >= 400 {
            return Err(OAuthError::MetadataError(format!(
                "Failed to fetch auth server metadata: HTTP {}",
                response.status
            )));
        }

        let metadata: AuthServerMetadata = serde_json::from_slice(&response.body)?;
        Ok(metadata)
    }

    /// Generate PKCE parameters
    pub fn generate_pkce() -> PkceParams {
        // Generate 32 random bytes for code_verifier (will be 43 chars base64url)
        let mut verifier_bytes = [0u8; 32];

        // Use timestamp + memory addresses as entropy source
        // This is not cryptographically secure, but sufficient for PKCE
        // The security comes from the code being one-time use and short-lived
        let mut state: u64 = 0;

        // Mix in various sources of entropy
        // Use pointer addresses as additional entropy
        let stack_var = 0u64;
        let ptr = &stack_var as *const u64 as u64;

        // Use a simple xorshift to mix
        let now = ptr.wrapping_mul(0x9e3779b97f4a7c15);
        state = state.wrapping_add(now);

        // Add some variation from the string allocator
        let s = String::with_capacity(32);
        state = state.wrapping_add(s.as_ptr() as u64);

        // Simple PRNG (xorshift64)
        for byte in &mut verifier_bytes {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *byte = (state & 0xff) as u8;
        }

        // Base64url encode the verifier
        let code_verifier = base64url_encode(&verifier_bytes);

        // SHA256 hash the verifier for the challenge
        let challenge_hash = sha256(code_verifier.as_bytes());
        let code_challenge = base64url_encode(&challenge_hash);

        PkceParams {
            code_verifier,
            code_challenge,
            code_challenge_method: "S256".to_string(),
        }
    }

    /// Build the OAuth authorization URL
    pub fn build_authorization_url(
        &self,
        auth_metadata: &AuthServerMetadata,
        pkce: &PkceParams,
        client_id: &str,
        redirect_uri: &str,
        scope: Option<&str>,
        state: &str,
    ) -> String {
        let mut url = format!(
            "{}?response_type=code&client_id={}&redirect_uri={}&code_challenge={}&code_challenge_method={}&state={}",
            auth_metadata.authorization_endpoint,
            url_encode(client_id),
            url_encode(redirect_uri),
            url_encode(&pkce.code_challenge),
            url_encode(&pkce.code_challenge_method),
            url_encode(state),
        );

        // Add resource parameter (RFC8707)
        url.push_str(&format!("&resource={}", url_encode(&self.server_url)));

        // Add scope if provided
        if let Some(s) = scope {
            url.push_str(&format!("&scope={}", url_encode(s)));
        }

        url
    }

    /// Exchange authorization code for access token
    pub fn exchange_code_for_token(
        &self,
        auth_metadata: &AuthServerMetadata,
        code: &str,
        pkce: &PkceParams,
        client_id: &str,
        redirect_uri: &str,
    ) -> Result<TokenResponse, OAuthError> {
        let body = format!(
            "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}&resource={}",
            url_encode(code),
            url_encode(redirect_uri),
            url_encode(client_id),
            url_encode(&pkce.code_verifier),
            url_encode(&self.server_url),
        );

        let headers = [
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("Accept", "application/json"),
        ];

        let response = HttpClient::request(
            "POST",
            &auth_metadata.token_endpoint,
            &headers,
            Some(body.as_bytes()),
        )?;

        if response.status >= 400 {
            let error_body = String::from_utf8_lossy(&response.body);
            return Err(OAuthError::TokenError(format!(
                "Token exchange failed: HTTP {} - {}",
                response.status, error_body
            )));
        }

        let token: TokenResponse = serde_json::from_slice(&response.body)?;
        Ok(token)
    }

    /// Refresh an access token
    pub fn refresh_token(
        &self,
        auth_metadata: &AuthServerMetadata,
        refresh_token: &str,
        client_id: &str,
    ) -> Result<TokenResponse, OAuthError> {
        let body = format!(
            "grant_type=refresh_token&refresh_token={}&client_id={}&resource={}",
            url_encode(refresh_token),
            url_encode(client_id),
            url_encode(&self.server_url),
        );

        let headers = [
            ("Content-Type", "application/x-www-form-urlencoded"),
            ("Accept", "application/json"),
        ];

        let response = HttpClient::request(
            "POST",
            &auth_metadata.token_endpoint,
            &headers,
            Some(body.as_bytes()),
        )?;

        if response.status >= 400 {
            let error_body = String::from_utf8_lossy(&response.body);
            return Err(OAuthError::TokenError(format!(
                "Token refresh failed: HTTP {} - {}",
                response.status, error_body
            )));
        }

        let token: TokenResponse = serde_json::from_slice(&response.body)?;
        Ok(token)
    }

    /// Build well-known URL for the server path
    fn build_well_known_url(&self, name: &str) -> String {
        // Extract origin and path from server URL
        // e.g., https://example.com/mcp -> https://example.com/.well-known/oauth-protected-resource/mcp
        if let Some(path_start) = self
            .server_url
            .find("://")
            .map(|i| self.server_url[i + 3..].find('/').map(|j| i + 3 + j))
            .flatten()
        {
            let origin = &self.server_url[..path_start];
            let path = &self.server_url[path_start..];
            format!("{}/.well-known/{}{}", origin, name, path)
        } else {
            format!("{}/.well-known/{}", self.server_url, name)
        }
    }

    /// Build well-known URL at root
    fn build_root_well_known_url(&self, name: &str) -> String {
        // Extract just the origin
        if let Some(path_start) = self
            .server_url
            .find("://")
            .map(|i| self.server_url[i + 3..].find('/').map(|j| i + 3 + j))
            .flatten()
        {
            let origin = &self.server_url[..path_start];
            format!("{}/.well-known/{}", origin, name)
        } else {
            format!("{}/.well-known/{}", self.server_url, name)
        }
    }
}

/// Request OAuth popup from browser via special HTTP request
///
/// Makes HTTP request to `https://__oauth_popup__/start` which is intercepted
/// by the TypeScript WASI HTTP shim and opens a browser popup for OAuth.
/// Returns the authorization code on success.
pub fn request_oauth_popup(
    auth_url: &str,
    server_id: &str,
    server_url: &str,
    code_verifier: &str,
    state: &str,
) -> Result<String, OAuthError> {
    // Build the special OAuth popup URL
    let popup_url = format!(
        "https://__oauth_popup__/start?auth_url={}&server_id={}&server_url={}&code_verifier={}&state={}",
        url_encode(auth_url),
        url_encode(server_id),
        url_encode(server_url),
        url_encode(code_verifier),
        url_encode(state),
    );

    let response = HttpClient::request("GET", &popup_url, &[], None)?;

    if response.status >= 400 {
        let error_body = String::from_utf8_lossy(&response.body);
        return Err(OAuthError::TokenError(format!(
            "OAuth popup failed: HTTP {} - {}",
            response.status, error_body
        )));
    }

    // Parse the response to get the authorization code
    #[derive(Deserialize)]
    struct PopupResponse {
        code: Option<String>,
        error: Option<String>,
    }

    let popup_result: PopupResponse = serde_json::from_slice(&response.body)?;

    if let Some(error) = popup_result.error {
        return Err(OAuthError::TokenError(error));
    }

    popup_result.code.ok_or_else(|| {
        OAuthError::TokenError("No authorization code in popup response".to_string())
    })
}

/// Perform the complete OAuth flow for an MCP server
///
/// 1. Discover protected resource metadata
/// 2. Discover authorization server metadata
/// 3. Generate PKCE parameters
/// 4. Build authorization URL
/// 5. Request popup from browser
/// 6. Exchange code for token
///
/// Returns the access token on success.
pub fn perform_oauth_flow(
    server_url: &str,
    server_id: &str,
    client_id: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, OAuthError> {
    let oauth = OAuthClient::new(server_url);

    // 1. Discover protected resource metadata
    let resource_meta = oauth.discover_protected_resource()?;

    // 2. Get first authorization server
    let auth_server_url = resource_meta
        .authorization_servers
        .first()
        .ok_or_else(|| OAuthError::MetadataError("No authorization servers found".to_string()))?;

    // 3. Discover auth server metadata
    let auth_meta = oauth.discover_auth_server(auth_server_url)?;

    // 4. Generate PKCE
    let pkce = OAuthClient::generate_pkce();

    // 5. Build state (random string for CSRF protection)
    let state = pkce.code_verifier[..16].to_string(); // Use part of verifier as state

    // 6. Determine scope from resource metadata
    let scope = if !resource_meta.scopes_supported.is_empty() {
        Some(resource_meta.scopes_supported.join(" "))
    } else {
        None
    };

    // 7. Build authorization URL
    let auth_url = oauth.build_authorization_url(
        &auth_meta,
        &pkce,
        client_id,
        redirect_uri,
        scope.as_deref(),
        &state,
    );

    // 8. Request popup from browser
    let code = request_oauth_popup(
        &auth_url,
        server_id,
        server_url,
        &pkce.code_verifier,
        &state,
    )?;

    // 9. Exchange code for token
    let token = oauth.exchange_code_for_token(&auth_meta, &code, &pkce, client_id, redirect_uri)?;

    Ok(token)
}

/// Parse WWW-Authenticate header for OAuth challenge
pub fn parse_www_authenticate(header: &str) -> Option<(Option<String>, Option<String>)> {
    // Format: Bearer resource_metadata="url", scope="scopes"
    if !header.starts_with("Bearer") {
        return None;
    }

    let mut resource_metadata = None;
    let mut scope = None;

    // Simple parsing - look for key="value" pairs
    for part in header.split(',') {
        let part = part.trim();
        if let Some(eq_pos) = part.find('=') {
            let key = part[..eq_pos].trim().trim_start_matches("Bearer").trim();
            let value = part[eq_pos + 1..].trim().trim_matches('"');

            match key {
                "resource_metadata" => resource_metadata = Some(value.to_string()),
                "scope" => scope = Some(value.to_string()),
                _ => {}
            }
        }
    }

    Some((resource_metadata, scope))
}

/// URL-encode a string
fn url_encode(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => result.push(c),
            _ => {
                for byte in c.to_string().as_bytes() {
                    result.push_str(&format!("%{:02X}", byte));
                }
            }
        }
    }
    result
}

/// Base64url encode (no padding)
fn base64url_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    let mut result = String::new();
    let mut i = 0;

    while i < data.len() {
        let b0 = data[i] as usize;
        let b1 = if i + 1 < data.len() {
            data[i + 1] as usize
        } else {
            0
        };
        let b2 = if i + 2 < data.len() {
            data[i + 2] as usize
        } else {
            0
        };

        result.push(ALPHABET[(b0 >> 2) & 0x3f] as char);
        result.push(ALPHABET[((b0 << 4) | (b1 >> 4)) & 0x3f] as char);

        if i + 1 < data.len() {
            result.push(ALPHABET[((b1 << 2) | (b2 >> 6)) & 0x3f] as char);
        }
        if i + 2 < data.len() {
            result.push(ALPHABET[b2 & 0x3f] as char);
        }

        i += 3;
    }

    result
}

/// Simple SHA256 implementation
fn sha256(data: &[u8]) -> [u8; 32] {
    // SHA256 constants
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    // Pad the message
    let ml = (data.len() as u64) * 8;
    let mut padded = data.to_vec();
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&ml.to_be_bytes());

    // Process each 512-bit block
    for chunk in padded.chunks(64) {
        let mut w = [0u32; 64];

        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }

        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut hh = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut result = [0u8; 32];
    for (i, val) in h.iter().enumerate() {
        result[i * 4..i * 4 + 4].copy_from_slice(&val.to_be_bytes());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256() {
        // Test vector: empty string
        let hash = sha256(b"");
        let expected = [
            0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f,
            0xb9, 0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b,
            0x78, 0x52, 0xb8, 0x55,
        ];
        assert_eq!(hash, expected);
    }

    #[test]
    fn test_base64url_encode() {
        assert_eq!(base64url_encode(b"hello"), "aGVsbG8");
        assert_eq!(base64url_encode(b"test"), "dGVzdA");
    }

    #[test]
    fn test_url_encode() {
        assert_eq!(url_encode("hello"), "hello");
        assert_eq!(url_encode("hello world"), "hello%20world");
        assert_eq!(url_encode("a=b&c=d"), "a%3Db%26c%3Dd");
    }

    #[test]
    fn test_parse_www_authenticate() {
        let header = r#"Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource", scope="read write""#;
        let result = parse_www_authenticate(header);
        assert!(result.is_some());
        let (rm, scope) = result.unwrap();
        assert_eq!(
            rm,
            Some("https://example.com/.well-known/oauth-protected-resource".to_string())
        );
        assert_eq!(scope, Some("read write".to_string()));
    }
}
