/**
 * Tests for OAuth 2.1 PKCE Authentication
 * 
 * Tests PKCE generation, token storage, callback parsing, URL building,
 * and discovery functions.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    generateCodeVerifier,
    generateCodeChallenge,
    generatePKCE,
    buildAuthorizationUrl,
    parseCallbackUrl,
    saveToken,
    getToken,
    removeToken,
    hasValidToken,
    getStoredClientId,
    saveClientId,
    discoverProtectedResource,
    discoverAuthServer,
    discoverOAuthEndpoints,
    createOAuthProvider,
    type AuthServerMetadata,
    type StoredToken,
} from './OAuthPkce';

// Mock localStorage
const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => { store[key] = value; },
        removeItem: (key: string) => { delete store[key]; },
        clear: () => { store = {}; },
    };
})();
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('OAuth PKCE', () => {
    beforeEach(() => {
        localStorageMock.clear();
        mockFetch.mockReset();
    });

    describe('generateCodeVerifier', () => {
        it('generates a string of appropriate length', () => {
            const verifier = generateCodeVerifier();
            // 32 bytes base64url encoded = 43 characters
            expect(verifier.length).toBeGreaterThanOrEqual(43);
            expect(verifier.length).toBeLessThanOrEqual(128);
        });

        it('generates URL-safe characters only', () => {
            const verifier = generateCodeVerifier();
            // Base64 URL encoding uses only alphanumeric, -, and _
            expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
        });

        it('generates unique values', () => {
            const v1 = generateCodeVerifier();
            const v2 = generateCodeVerifier();
            expect(v1).not.toBe(v2);
        });
    });

    describe('generateCodeChallenge', () => {
        it('generates SHA-256 hash of verifier', async () => {
            const challenge = await generateCodeChallenge('test-verifier');
            expect(challenge).toBeDefined();
            expect(typeof challenge).toBe('string');
        });

        it('generates consistent hash for same input', async () => {
            const c1 = await generateCodeChallenge('same-verifier');
            const c2 = await generateCodeChallenge('same-verifier');
            expect(c1).toBe(c2);
        });

        it('generates different hash for different input', async () => {
            const c1 = await generateCodeChallenge('verifier-1');
            const c2 = await generateCodeChallenge('verifier-2');
            expect(c1).not.toBe(c2);
        });

        it('generates URL-safe output', async () => {
            const challenge = await generateCodeChallenge('test');
            expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(challenge).not.toContain('+');
            expect(challenge).not.toContain('/');
            expect(challenge).not.toContain('=');
        });
    });

    describe('generatePKCE', () => {
        it('returns verifier and challenge pair', async () => {
            const pkce = await generatePKCE();
            expect(pkce.codeVerifier).toBeDefined();
            expect(pkce.codeChallenge).toBeDefined();
        });

        it('challenge is derived from verifier', async () => {
            const pkce = await generatePKCE();
            const expected = await generateCodeChallenge(pkce.codeVerifier);
            expect(pkce.codeChallenge).toBe(expected);
        });
    });

    describe('buildAuthorizationUrl', () => {
        const mockAuthServer: AuthServerMetadata = {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code'],
        };

        it('builds correct authorization URL', () => {
            const url = buildAuthorizationUrl(
                mockAuthServer,
                'client-123',
                'https://app.example.com/callback',
                'challenge-abc',
                ['read', 'write'],
                'state-xyz',
                'https://api.example.com'
            );

            expect(url).toContain('https://auth.example.com/authorize?');
            expect(url).toContain('response_type=code');
            expect(url).toContain('client_id=client-123');
            expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback');
            expect(url).toContain('code_challenge=challenge-abc');
            expect(url).toContain('code_challenge_method=S256');
            expect(url).toContain('state=state-xyz');
            expect(url).toContain('resource=https%3A%2F%2Fapi.example.com');
            expect(url).toContain('scope=read+write');
        });

        it('omits scope when empty', () => {
            const url = buildAuthorizationUrl(
                mockAuthServer,
                'client-123',
                'https://app.example.com/callback',
                'challenge-abc',
                [],
                'state-xyz',
                'https://api.example.com'
            );

            expect(url).not.toContain('scope=');
        });
    });

    describe('parseCallbackUrl', () => {
        it('parses successful callback with code and state', () => {
            const result = parseCallbackUrl(
                'https://app.example.com/callback?code=auth-code-123&state=state-abc'
            );

            expect('code' in result).toBe(true);
            if ('code' in result) {
                expect(result.code).toBe('auth-code-123');
                expect(result.state).toBe('state-abc');
            }
        });

        it('parses error callback', () => {
            const result = parseCallbackUrl(
                'https://app.example.com/callback?error=access_denied&error_description=User+denied+access'
            );

            expect('error' in result).toBe(true);
            if ('error' in result) {
                expect(result.error).toBe('access_denied');
                expect(result.errorDescription).toBe('User denied access');
            }
        });

        it('returns error for missing code', () => {
            const result = parseCallbackUrl(
                'https://app.example.com/callback?state=abc'
            );

            expect('error' in result).toBe(true);
            if ('error' in result) {
                expect(result.error).toBe('missing_params');
            }
        });

        it('returns error for missing state', () => {
            const result = parseCallbackUrl(
                'https://app.example.com/callback?code=abc'
            );

            expect('error' in result).toBe(true);
            if ('error' in result) {
                expect(result.error).toBe('missing_params');
            }
        });
    });

    describe('Token Storage', () => {
        const testServerUrl = 'https://mcp.example.com';
        const testToken: StoredToken = {
            accessToken: 'access-token-123',
            refreshToken: 'refresh-token-456',
            expiresAt: Date.now() + 3600000, // 1 hour from now
            scopes: ['read', 'write'],
            serverUrl: testServerUrl,
        };

        it('saves and retrieves token', () => {
            saveToken(testServerUrl, testToken);
            const retrieved = getToken(testServerUrl);

            expect(retrieved).not.toBeNull();
            expect(retrieved?.accessToken).toBe('access-token-123');
            expect(retrieved?.refreshToken).toBe('refresh-token-456');
        });

        it('returns null for non-existent token', () => {
            const token = getToken('https://unknown.example.com');
            expect(token).toBeNull();
        });

        it('removes token', () => {
            saveToken(testServerUrl, testToken);
            removeToken(testServerUrl);
            const token = getToken(testServerUrl);
            expect(token).toBeNull();
        });

        it('hasValidToken returns true for valid token', () => {
            saveToken(testServerUrl, testToken);
            expect(hasValidToken(testServerUrl)).toBe(true);
        });

        it('hasValidToken returns false for missing token', () => {
            expect(hasValidToken('https://missing.example.com')).toBe(false);
        });

        it('returns null for expired token', () => {
            const expiredToken: StoredToken = {
                ...testToken,
                expiresAt: Date.now() - 1000, // 1 second ago
            };
            saveToken(testServerUrl, expiredToken);
            const token = getToken(testServerUrl);
            expect(token).toBeNull();
        });

        it('returns null for token expiring within 60 seconds', () => {
            const soonExpiringToken: StoredToken = {
                ...testToken,
                expiresAt: Date.now() + 30000, // 30 seconds from now
            };
            saveToken(testServerUrl, soonExpiringToken);
            const token = getToken(testServerUrl);
            expect(token).toBeNull();
        });

        it('handles malformed JSON gracefully', () => {
            // Directly set invalid JSON
            const encoder = new TextEncoder();
            const data = encoder.encode(testServerUrl);
            let hash = 0;
            for (const byte of data) {
                hash = ((hash << 5) - hash) + byte;
                hash = hash & hash;
            }
            const key = `mcp_oauth_token_${Math.abs(hash).toString(36)}`;
            localStorageMock.setItem(key, 'invalid-json');

            const token = getToken(testServerUrl);
            expect(token).toBeNull();
        });
    });

    describe('Client ID Storage', () => {
        it('saves and retrieves client ID', () => {
            const serverUrl = 'https://mcp.example.com';
            saveClientId(serverUrl, 'client-123');
            expect(getStoredClientId(serverUrl)).toBe('client-123');
        });

        it('returns null for missing client ID', () => {
            expect(getStoredClientId('https://unknown.com')).toBeNull();
        });
    });

    describe('createOAuthProvider', () => {
        it('returns provider with getAccessToken method', async () => {
            const serverUrl = 'https://mcp.example.com';
            const token: StoredToken = {
                accessToken: 'test-access-token',
                expiresAt: Date.now() + 3600000,
                scopes: ['read'],
                serverUrl,
            };
            saveToken(serverUrl, token);

            const provider = createOAuthProvider(serverUrl);
            const accessToken = await provider.getAccessToken();
            expect(accessToken).toBe('test-access-token');
        });

        it('returns null when no token exists', async () => {
            const provider = createOAuthProvider('https://no-token.com');
            const accessToken = await provider.getAccessToken();
            expect(accessToken).toBeNull();
        });
    });

    describe('Discovery (with mocked fetch)', () => {
        describe('discoverProtectedResource', () => {
            it('uses cached config for well-known servers (Stripe)', async () => {
                // Stripe is a well-known server - should not make fetch call
                const resource = await discoverProtectedResource('https://mcp.stripe.com/v1');

                expect(mockFetch).not.toHaveBeenCalled();
                expect(resource.resource).toBe('https://mcp.stripe.com');
                expect(resource.authorization_servers).toContain('https://access.stripe.com/mcp');
            });

            it('fetches from path-specific endpoint first', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        resource: 'https://api.example.com/mcp',
                        authorization_servers: ['https://auth.example.com'],
                    }),
                });

                const resource = await discoverProtectedResource('https://api.example.com/mcp');

                expect(mockFetch).toHaveBeenCalledWith(
                    'https://api.example.com/.well-known/oauth-protected-resource/mcp'
                );
                expect(resource.resource).toBe('https://api.example.com/mcp');
            });

            it('falls back to root endpoint', async () => {
                mockFetch
                    .mockRejectedValueOnce(new Error('Not found')) // Path-specific fails
                    .mockResolvedValueOnce({
                        ok: true,
                        json: async () => ({
                            resource: 'https://api.example.com',
                            authorization_servers: ['https://auth.example.com'],
                        }),
                    });

                const resource = await discoverProtectedResource('https://api.example.com/mcp');

                expect(mockFetch).toHaveBeenCalledTimes(2);
                expect(resource.resource).toBe('https://api.example.com');
            });

            it('throws on complete failure', async () => {
                mockFetch
                    .mockRejectedValueOnce(new Error('Not found'))
                    .mockResolvedValueOnce({ ok: false, status: 404 });

                await expect(
                    discoverProtectedResource('https://unknown.example.com/mcp')
                ).rejects.toThrow('Failed to discover protected resource metadata');
            });
        });

        describe('discoverAuthServer', () => {
            it('tries multiple discovery URLs', async () => {
                // Fail first two, succeed on third
                mockFetch
                    .mockResolvedValueOnce({ ok: false })
                    .mockResolvedValueOnce({ ok: false })
                    .mockResolvedValueOnce({
                        ok: true,
                        json: async () => ({
                            issuer: 'https://auth.example.com',
                            authorization_endpoint: 'https://auth.example.com/authorize',
                            token_endpoint: 'https://auth.example.com/token',
                            response_types_supported: ['code'],
                        }),
                    });

                const authServer = await discoverAuthServer('https://auth.example.com');

                expect(authServer.issuer).toBe('https://auth.example.com');
                expect(mockFetch).toHaveBeenCalledTimes(3);
            });

            it('throws when all discovery attempts fail', async () => {
                mockFetch.mockResolvedValue({ ok: false });

                await expect(
                    discoverAuthServer('https://unknown-auth.example.com')
                ).rejects.toThrow('Failed to discover authorization server metadata');
            });
        });

        describe('discoverOAuthEndpoints', () => {
            it('returns cached endpoints for well-known servers', async () => {
                const result = await discoverOAuthEndpoints('https://mcp.stripe.com');

                expect(mockFetch).not.toHaveBeenCalled();
                expect(result.resource.resource).toBe('https://mcp.stripe.com');
                expect(result.authServer.issuer).toBe('https://access.stripe.com/mcp');
            });

            it('discovers both resource and auth server metadata', async () => {
                // First call: protected resource
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        resource: 'https://api.example.com',
                        authorization_servers: ['https://auth.example.com'],
                    }),
                });

                // Second call: auth server
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        issuer: 'https://auth.example.com',
                        authorization_endpoint: 'https://auth.example.com/authorize',
                        token_endpoint: 'https://auth.example.com/token',
                        response_types_supported: ['code'],
                    }),
                });

                const result = await discoverOAuthEndpoints('https://api.example.com');

                expect(result.resource.resource).toBe('https://api.example.com');
                expect(result.authServer.issuer).toBe('https://auth.example.com');
            });

            it('throws when no authorization servers found', async () => {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        resource: 'https://api.example.com',
                        authorization_servers: [], // Empty!
                    }),
                });

                await expect(
                    discoverOAuthEndpoints('https://api.example.com')
                ).rejects.toThrow('No authorization servers found');
            });
        });
    });
});
