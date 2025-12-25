/**
 * OAuth 2.1 PKCE Authentication for Remote MCP Servers
 * 
 * Implements the MCP Authorization Specification (2025-11-25):
 * - RFC 9728: Protected Resource Metadata discovery
 * - RFC 8414: Authorization Server Metadata discovery
 * - RFC 7591: Dynamic Client Registration (optional)
 * - OAuth 2.1 with PKCE for browser clients
 */

// ============ Types ============

export interface ProtectedResourceMetadata {
    resource: string;
    authorization_servers: string[];
    scopes_supported?: string[];
    bearer_methods_supported?: string[];
}

/**
 * Auth server metadata - compatible with mcp-auth's AuthorizationServerMetadata
 * but uses snake_case to match OAuth 2.0 spec (RFC 8414)
 */
export interface AuthServerMetadata {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
    response_types_supported: string[];
    code_challenge_methods_supported?: string[];
    client_id_metadata_document_supported?: boolean;
    jwks_uri?: string;
}

export interface TokenResponse {
    access_token: string;
    token_type: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
}

export interface StoredToken {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    scopes: string[];
    serverUrl: string;
}

export interface PKCEChallenge {
    codeVerifier: string;
    codeChallenge: string;
}

export interface OAuthState {
    serverUrl: string;
    codeVerifier: string;
    scopes: string[];
    nonce: string;
}

// ============ Constants ============

const TOKEN_STORAGE_PREFIX = 'mcp_oauth_token_';
const STATE_STORAGE_KEY = 'mcp_oauth_state';
const CALLBACK_PATH = '/oauth/callback';

// ============ PKCE Generation ============

/**
 * Generate a cryptographically secure random string for PKCE code verifier
 * Must be between 43-128 characters per RFC 7636
 */
export function generateCodeVerifier(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return base64UrlEncode(array);
}

/**
 * Generate the code challenge from the verifier using SHA-256
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(hash));
}

/**
 * Generate a complete PKCE challenge pair
 */
export async function generatePKCE(): Promise<PKCEChallenge> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    return { codeVerifier, codeChallenge };
}

/**
 * Base64 URL encoding (no padding, URL-safe characters)
 */
function base64UrlEncode(buffer: Uint8Array): string {
    const base64 = btoa(String.fromCharCode(...buffer));
    return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// ============ Well-Known Server Metadata Cache ============

/**
 * Cache of well-known MCP server OAuth metadata.
 * Used to bypass CORS issues with servers that don't set Access-Control-Allow-Origin
 * on their OAuth discovery endpoints.
 */
interface WellKnownServerConfig {
    resource: ProtectedResourceMetadata;
    authServer: AuthServerMetadata;
}

const WELL_KNOWN_SERVERS: Record<string, WellKnownServerConfig> = {
    // Stripe MCP Server - their discovery endpoints don't have CORS headers
    'mcp.stripe.com': {
        resource: {
            resource: 'https://mcp.stripe.com',
            authorization_servers: ['https://access.stripe.com/mcp'],
            scopes_supported: ['mcp'],
        },
        authServer: {
            issuer: 'https://access.stripe.com/mcp',
            authorization_endpoint: 'https://access.stripe.com/mcp/oauth2/authorize',
            token_endpoint: 'https://access.stripe.com/mcp/oauth2/token',
            registration_endpoint: 'https://access.stripe.com/mcp/oauth2/register',
            response_types_supported: ['code'],
            scopes_supported: ['mcp'],
            code_challenge_methods_supported: ['S256'],
        },
    },
};

/**
 * Check if a server URL matches a well-known server
 * Matches on hostname only, ignoring path variations
 */
function getWellKnownConfig(mcpServerUrl: string): WellKnownServerConfig | null {
    try {
        const url = new URL(mcpServerUrl);
        const hostname = url.hostname;

        // Direct match
        if (WELL_KNOWN_SERVERS[hostname]) {
            return WELL_KNOWN_SERVERS[hostname];
        }

        return null;
    } catch {
        return null;
    }
}

// ============ Discovery ============

/**
 * Discover Protected Resource Metadata (RFC 9728)
 * MCP servers MUST implement this
 */
export async function discoverProtectedResource(
    mcpServerUrl: string
): Promise<ProtectedResourceMetadata> {
    // Check well-known cache first (bypasses CORS issues)
    const wellKnown = getWellKnownConfig(mcpServerUrl);
    if (wellKnown) {
        console.log('[OAuth] Using cached metadata for well-known server:', mcpServerUrl);
        return wellKnown.resource;
    }

    const url = new URL(mcpServerUrl);

    // Try path-specific metadata first
    const pathMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;

    try {
        const response = await fetch(pathMetadataUrl);
        if (response.ok) {
            return await response.json();
        }
    } catch (_e) {
        console.log('[OAuth] Path-specific PRM not found, trying root');
    }

    // Fall back to root metadata
    const rootMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
    const response = await fetch(rootMetadataUrl);

    if (!response.ok) {
        throw new Error(`Failed to discover protected resource metadata: ${response.status}`);
    }

    return await response.json();
}

/**
 * Discover Authorization Server Metadata (RFC 8414)
 * Tries both OAuth 2.0 and OpenID Connect discovery
 */
export async function discoverAuthServer(
    authServerUrl: string
): Promise<AuthServerMetadata> {
    const url = new URL(authServerUrl);

    // URLs to try in order (per MCP spec)
    const discoveryUrls = [
        // OAuth 2.0 with path insertion
        `${url.origin}/.well-known/oauth-authorization-server${url.pathname}`,
        // OpenID Connect with path insertion
        `${url.origin}/.well-known/openid-configuration${url.pathname}`,
        // OpenID Connect path appending
        `${authServerUrl}/.well-known/openid-configuration`,
        // OAuth 2.0 at root
        `${url.origin}/.well-known/oauth-authorization-server`,
        // OpenID Connect at root
        `${url.origin}/.well-known/openid-configuration`,
    ];

    for (const discoveryUrl of discoveryUrls) {
        try {
            console.log('[OAuth] Trying discovery URL:', discoveryUrl);
            const response = await fetch(discoveryUrl);
            if (response.ok) {
                const metadata = await response.json();
                console.log('[OAuth] Found auth server metadata:', metadata.issuer);
                return metadata;
            }
        } catch (_e) {
            // Continue to next URL
        }
    }

    throw new Error(`Failed to discover authorization server metadata for ${authServerUrl}`);
}

/**
 * Complete OAuth discovery: find auth server from MCP server URL
 */
export async function discoverOAuthEndpoints(
    mcpServerUrl: string
): Promise<{ resource: ProtectedResourceMetadata; authServer: AuthServerMetadata }> {
    // Check well-known cache first (bypasses CORS issues)
    const wellKnown = getWellKnownConfig(mcpServerUrl);
    if (wellKnown) {
        console.log('[OAuth] Using cached OAuth endpoints for well-known server');
        return wellKnown;
    }

    // Step 1: Discover protected resource metadata
    const resource = await discoverProtectedResource(mcpServerUrl);
    console.log('[OAuth] Protected resource:', resource);

    if (!resource.authorization_servers || resource.authorization_servers.length === 0) {
        throw new Error('No authorization servers found in protected resource metadata');
    }

    // Step 2: Discover auth server metadata (use first one)
    const authServerUrl = resource.authorization_servers[0];
    const authServer = await discoverAuthServer(authServerUrl);

    return { resource, authServer };
}

// ============ Authorization Flow ============

/**
 * Build the authorization URL for the OAuth flow
 */
export function buildAuthorizationUrl(
    authServer: AuthServerMetadata,
    clientId: string,
    redirectUri: string,
    codeChallenge: string,
    scopes: string[],
    state: string,
    resourceUrl: string
): string {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: state,
        // RFC 8707: Resource Indicators - required by MCP
        resource: resourceUrl,
    });

    if (scopes.length > 0) {
        params.set('scope', scopes.join(' '));
    }

    return `${authServer.authorization_endpoint}?${params.toString()}`;
}

/**
 * Initiate OAuth authorization flow in a popup window
 */
export async function initiateAuthFlow(
    mcpServerUrl: string,
    clientId: string
): Promise<{ popup: Window; state: OAuthState }> {
    // Discover OAuth endpoints
    const { resource, authServer } = await discoverOAuthEndpoints(mcpServerUrl);

    // Generate PKCE challenge
    const { codeVerifier, codeChallenge } = await generatePKCE();

    // Determine scopes (request all available)
    const scopes = resource.scopes_supported || authServer.scopes_supported || [];

    // Generate state nonce
    const nonce = generateCodeVerifier().substring(0, 16);

    // Store state for callback verification
    const oauthState: OAuthState = {
        serverUrl: mcpServerUrl,
        codeVerifier,
        scopes,
        nonce,
    };
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(oauthState));

    // Build redirect URI (current origin + callback path)
    const redirectUri = `${window.location.origin}${CALLBACK_PATH}`;

    // Build authorization URL
    const authUrl = buildAuthorizationUrl(
        authServer,
        clientId,
        redirectUri,
        codeChallenge,
        scopes,
        nonce,
        mcpServerUrl
    );

    console.log('[OAuth] Opening authorization URL:', authUrl);

    // Open popup
    const popup = window.open(
        authUrl,
        'mcp_oauth',
        'width=600,height=700,popup=yes'
    );

    if (!popup) {
        throw new Error('Failed to open OAuth popup. Please allow popups for this site.');
    }

    return { popup, state: oauthState };
}

/**
 * Wait for OAuth callback from popup
 */
export function waitForCallback(popup: Window): Promise<string> {
    return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
            try {
                // Check if popup is closed
                if (popup.closed) {
                    clearInterval(checkInterval);
                    reject(new Error('OAuth popup was closed'));
                    return;
                }

                // Check if we can access the popup URL (same origin after redirect)
                const currentUrl = popup.location.href;
                if (currentUrl.includes(CALLBACK_PATH)) {
                    clearInterval(checkInterval);
                    popup.close();
                    resolve(currentUrl);
                }
            } catch (_e) {
                // Cross-origin access - popup is still on external site
            }
        }, 500);

        // Timeout after 5 minutes
        setTimeout(() => {
            clearInterval(checkInterval);
            popup.close();
            reject(new Error('OAuth flow timed out'));
        }, 5 * 60 * 1000);
    });
}

/**
 * Parse the authorization code from callback URL
 */
export function parseCallbackUrl(
    callbackUrl: string
): { code: string; state: string } | { error: string; errorDescription?: string } {
    const url = new URL(callbackUrl);
    const params = url.searchParams;

    const error = params.get('error');
    if (error) {
        return {
            error,
            errorDescription: params.get('error_description') || undefined,
        };
    }

    const code = params.get('code');
    const state = params.get('state');

    if (!code || !state) {
        return { error: 'missing_params', errorDescription: 'Missing code or state parameter' };
    }

    return { code, state };
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
    authServer: AuthServerMetadata,
    code: string,
    codeVerifier: string,
    clientId: string,
    redirectUri: string,
    resourceUrl: string
): Promise<TokenResponse> {
    const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
        resource: resourceUrl,
    });

    const response = await fetch(authServer.token_endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${response.status} - ${error}`);
    }

    return await response.json();
}

/**
 * Complete the OAuth flow after callback
 */
export async function handleOAuthCallback(
    callbackUrl: string,
    clientId: string
): Promise<StoredToken> {
    // Parse callback
    const result = parseCallbackUrl(callbackUrl);
    if ('error' in result) {
        throw new Error(`OAuth error: ${result.error} - ${result.errorDescription || ''}`);
    }

    // Retrieve stored state
    const stateJson = localStorage.getItem(STATE_STORAGE_KEY);
    if (!stateJson) {
        throw new Error('OAuth state not found - flow may have expired');
    }

    const state: OAuthState = JSON.parse(stateJson);

    // Verify state nonce
    if (result.state !== state.nonce) {
        throw new Error('OAuth state mismatch - possible CSRF attack');
    }

    // Clean up state
    localStorage.removeItem(STATE_STORAGE_KEY);

    // Discover auth server again for token endpoint
    const { authServer } = await discoverOAuthEndpoints(state.serverUrl);

    // Exchange code for tokens
    const redirectUri = `${window.location.origin}${CALLBACK_PATH}`;
    const tokens = await exchangeCodeForTokens(
        authServer,
        result.code,
        state.codeVerifier,
        clientId,
        redirectUri,
        state.serverUrl
    );

    // Store tokens
    const storedToken: StoredToken = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in
            ? Date.now() + tokens.expires_in * 1000
            : Date.now() + 3600 * 1000, // Default 1 hour
        scopes: tokens.scope?.split(' ') || state.scopes,
        serverUrl: state.serverUrl,
    };

    saveToken(state.serverUrl, storedToken);
    console.log('[OAuth] Tokens stored for', state.serverUrl);

    return storedToken;
}

// ============ Token Storage ============

function getTokenKey(serverUrl: string): string {
    // Use a hash of the URL to avoid issues with special characters
    const encoder = new TextEncoder();
    const data = encoder.encode(serverUrl);
    let hash = 0;
    for (const byte of data) {
        hash = ((hash << 5) - hash) + byte;
        hash = hash & hash; // Convert to 32bit integer
    }
    return `${TOKEN_STORAGE_PREFIX}${Math.abs(hash).toString(36)}`;
}

export function saveToken(serverUrl: string, token: StoredToken): void {
    const key = getTokenKey(serverUrl);
    localStorage.setItem(key, JSON.stringify(token));
}

export function getToken(serverUrl: string): StoredToken | null {
    const key = getTokenKey(serverUrl);
    const json = localStorage.getItem(key);
    if (!json) return null;

    try {
        const token: StoredToken = JSON.parse(json);

        // Check if token is expired (with 60s buffer)
        if (token.expiresAt < Date.now() + 60000) {
            console.log('[OAuth] Token expired for', serverUrl);
            // Could trigger refresh here if we have refresh token
            if (token.refreshToken) {
                // TODO: Implement token refresh
                console.log('[OAuth] Has refresh token, but refresh not yet implemented');
            }
            return null;
        }

        return token;
    } catch (e) {
        console.error('[OAuth] Failed to parse stored token:', e);
        return null;
    }
}

export function removeToken(serverUrl: string): void {
    const key = getTokenKey(serverUrl);
    localStorage.removeItem(key);
}

export function hasValidToken(serverUrl: string): boolean {
    return getToken(serverUrl) !== null;
}

// ============ Auth Provider for Vercel AI SDK ============

/**
 * Create an OAuth auth provider compatible with Vercel AI SDK's MCP client
 * This can be passed as the `authProvider` option
 */
export function createOAuthProvider(serverUrl: string) {
    return {
        async getAccessToken(): Promise<string | null> {
            const token = getToken(serverUrl);
            return token?.accessToken || null;
        },

        async refreshAccessToken(): Promise<string | null> {
            // TODO: Implement token refresh using refresh_token
            console.log('[OAuth] Token refresh not yet implemented');
            return null;
        },
    };
}

// ============ Dynamic Client Registration (RFC 7591) ============

export interface DynamicClientConfig {
    client_name: string;
    redirect_uris: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
}

export interface DynamicClientResponse {
    client_id: string;
    client_secret?: string;
    client_id_issued_at?: number;
    client_secret_expires_at?: number;
}

const CLIENT_ID_STORAGE_PREFIX = 'mcp_client_id_';

/**
 * Get stored client ID for a server URL
 */
export function getStoredClientId(serverUrl: string): string | null {
    const key = getClientIdKey(serverUrl);
    return localStorage.getItem(key);
}

/**
 * Store client ID for a server URL
 */
export function saveClientId(serverUrl: string, clientId: string): void {
    const key = getClientIdKey(serverUrl);
    localStorage.setItem(key, clientId);
}

/**
 * Generate storage key for client ID
 */
function getClientIdKey(serverUrl: string): string {
    const encoder = new TextEncoder();
    const data = encoder.encode(serverUrl);
    let hash = 0;
    for (const byte of data) {
        hash = ((hash << 5) - hash) + byte;
        hash = hash & hash;
    }
    return `${CLIENT_ID_STORAGE_PREFIX}${Math.abs(hash).toString(36)}`;
}

/**
 * Dynamically register a client with the authorization server
 */
export async function registerClient(
    authServer: AuthServerMetadata,
    config: DynamicClientConfig
): Promise<DynamicClientResponse> {
    if (!authServer.registration_endpoint) {
        throw new Error('Authorization server does not support dynamic client registration');
    }

    console.log('[OAuth] Registering client at:', authServer.registration_endpoint);

    const response = await fetch(authServer.registration_endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            ...config,
            grant_types: config.grant_types || ['authorization_code', 'refresh_token'],
            response_types: config.response_types || ['code'],
            token_endpoint_auth_method: config.token_endpoint_auth_method || 'none',
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Client registration failed: ${response.status} - ${error}`);
    }

    const result = await response.json();
    console.log('[OAuth] Client registered successfully, client_id:', result.client_id);
    return result;
}

/**
 * Get or register a client ID for an MCP server.
 * If no clientId is provided and the server supports DCR, auto-register.
 */
export async function getOrRegisterClientId(
    mcpServerUrl: string,
    authServer: AuthServerMetadata,
    providedClientId?: string
): Promise<string> {
    // Use provided client ID if available
    if (providedClientId) {
        console.log('[OAuth] Using provided client ID');
        saveClientId(mcpServerUrl, providedClientId);
        return providedClientId;
    }

    // Check for stored client ID
    const storedClientId = getStoredClientId(mcpServerUrl);
    if (storedClientId) {
        console.log('[OAuth] Using stored client ID');
        return storedClientId;
    }

    // Check if server supports Dynamic Client Registration
    if (!authServer.registration_endpoint) {
        throw new Error(
            'No client ID provided and server does not support Dynamic Client Registration. ' +
            'Please provide a client ID with --client-id <id>'
        );
    }

    // Auto-register via DCR
    console.log('[OAuth] No client ID found, attempting Dynamic Client Registration...');

    const redirectUri = `${window.location.origin}${CALLBACK_PATH}`;
    const clientResponse = await registerClient(authServer, {
        client_name: 'Agent in a Browser',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
    });

    // Store the registered client ID
    saveClientId(mcpServerUrl, clientResponse.client_id);

    return clientResponse.client_id;
}

// ============ High-Level API ============

/**
 * Complete OAuth flow for an MCP server
 * Returns a token that can be used for API calls
 * 
 * @param mcpServerUrl - The MCP server URL
 * @param clientId - Optional client ID. If not provided and server supports DCR, will auto-register.
 */
export async function authenticateWithServer(
    mcpServerUrl: string,
    clientId?: string
): Promise<StoredToken> {
    // Check for existing valid token
    const existingToken = getToken(mcpServerUrl);
    if (existingToken) {
        console.log('[OAuth] Using existing token for', mcpServerUrl);
        return existingToken;
    }

    // Discover OAuth endpoints first to check for DCR support
    const { authServer } = await discoverOAuthEndpoints(mcpServerUrl);

    // Get or register client ID
    const effectiveClientId = await getOrRegisterClientId(mcpServerUrl, authServer, clientId);

    // Initiate OAuth flow
    const { popup, state: _state } = await initiateAuthFlow(mcpServerUrl, effectiveClientId);

    // Wait for callback
    const callbackUrl = await waitForCallback(popup);

    // Handle callback and get tokens
    return await handleOAuthCallback(callbackUrl, effectiveClientId);
}
