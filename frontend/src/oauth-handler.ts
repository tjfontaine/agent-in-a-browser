/**
 * OAuth Handler for MCP Server Authentication
 * 
 * Handles OAuth 2.1 authorization flow via browser popup.
 * Used when connecting to protected MCP servers that require authentication.
 */

// Type for OAuth flow state
interface OAuthFlowState {
    serverId: string;
    serverUrl: string;
    codeVerifier: string;
    state: string;
    redirectUri: string;
    resolve: (code: string) => void;
    reject: (error: Error) => void;
}

// Active OAuth flows keyed by state parameter
const activeFlows = new Map<string, OAuthFlowState>();

// Popup window reference
let oauthPopup: Window | null = null;

/**
 * Generate a random state string for OAuth
 */
function generateState(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get the OAuth redirect URI based on current origin
 */
export function getRedirectUri(): string {
    return `${window.location.origin}/oauth-callback`;
}

/**
 * Open OAuth authorization popup
 * 
 * @param authUrl The full OAuth authorization URL with all parameters
 * @param serverId ID of the server being authenticated
 * @param serverUrl URL of the MCP server
 * @param codeVerifier The PKCE code verifier (needed for token exchange)
 * @param state The state parameter (for CSRF protection)
 * @returns Promise resolving to the authorization code
 */
export function openOAuthPopup(
    authUrl: string,
    serverId: string,
    serverUrl: string,
    codeVerifier: string,
    state: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        // Close any existing popup
        if (oauthPopup && !oauthPopup.closed) {
            oauthPopup.close();
        }

        // Store flow state
        activeFlows.set(state, {
            serverId,
            serverUrl,
            codeVerifier,
            state,
            redirectUri: getRedirectUri(),
            resolve,
            reject,
        });

        // Calculate popup position (centered)
        const width = 600;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;

        // Open popup
        oauthPopup = window.open(
            authUrl,
            'mcp-oauth',
            `width=${width},height=${height},left=${left},top=${top},popup=yes`
        );

        if (!oauthPopup) {
            activeFlows.delete(state);
            reject(new Error('Failed to open OAuth popup. Please check your popup blocker settings.'));
            return;
        }

        // Poll for popup close
        const pollTimer = setInterval(() => {
            if (oauthPopup?.closed) {
                clearInterval(pollTimer);
                const flow = activeFlows.get(state);
                if (flow) {
                    activeFlows.delete(state);
                    flow.reject(new Error('OAuth popup was closed before completing authorization'));
                }
            }
        }, 500);

        // Set a timeout for the flow
        setTimeout(() => {
            clearInterval(pollTimer);
            const flow = activeFlows.get(state);
            if (flow) {
                activeFlows.delete(state);
                if (oauthPopup && !oauthPopup.closed) {
                    oauthPopup.close();
                }
                flow.reject(new Error('OAuth authorization timed out'));
            }
        }, 5 * 60 * 1000); // 5 minute timeout
    });
}

/**
 * Handle OAuth callback (called from callback page)
 * 
 * @param code The authorization code from the OAuth provider
 * @param state The state parameter for matching the flow
 * @returns True if the flow was found and handled
 */
export function handleOAuthCallback(code: string, state: string): boolean {
    const flow = activeFlows.get(state);
    if (!flow) {
        console.error('[OAuth] No active flow found for state:', state);
        return false;
    }

    activeFlows.delete(state);

    // Close the popup
    if (oauthPopup && !oauthPopup.closed) {
        oauthPopup.close();
    }

    flow.resolve(code);
    return true;
}

/**
 * Handle OAuth error (called from callback page)
 * 
 * @param error Error code
 * @param errorDescription Error description
 * @param state The state parameter for matching the flow
 */
export function handleOAuthError(error: string, errorDescription: string, state: string): boolean {
    const flow = activeFlows.get(state);
    if (!flow) {
        console.error('[OAuth] No active flow found for state:', state);
        return false;
    }

    activeFlows.delete(state);

    // Close the popup
    if (oauthPopup && !oauthPopup.closed) {
        oauthPopup.close();
    }

    flow.reject(new Error(`OAuth error: ${error} - ${errorDescription}`));
    return true;
}

/**
 * Get the code verifier for a completed flow (needed for token exchange)
 */
export function getCodeVerifier(state: string): string | null {
    const flow = activeFlows.get(state);
    return flow?.codeVerifier ?? null;
}

// Listen for messages from the OAuth callback popup
window.addEventListener('message', (event) => {
    // Only accept messages from our own origin
    if (event.origin !== window.location.origin) {
        return;
    }

    const { type, code, state, error, errorDescription } = event.data;

    if (type === 'oauth-callback') {
        if (error) {
            handleOAuthError(error, errorDescription || '', state);
        } else if (code && state) {
            handleOAuthCallback(code, state);
        }
    }
});

// Export for use by the TUI
export type { OAuthFlowState };
