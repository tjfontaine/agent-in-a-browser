/**
 * Test Configuration Helper
 * 
 * Provides utilities to pre-seed configuration files in OPFS before tests run.
 * This eliminates the need for manual UI-based config entry in E2E tests.
 */

import type { Page } from '@playwright/test';

/**
 * Default test config with a fake API key for tests that need one.
 * Using 'test-' prefix makes it clear this isn't a real key.
 */
export const DEFAULT_TEST_CONFIG = `
[providers]
default = "anthropic"

[providers.anthropic]
model = "claude-sonnet-4-20250514"
api_key = "test-api-key-for-e2e-testing"
api_format = "anthropic"

[providers.openai]
model = "gpt-4o"
api_format = "openai"

[ui]
theme = "dark"
aux_panel = true
`;

/**
 * Write a config.toml file to OPFS before the TUI loads.
 * This navigates to a minimal page first to ensure same-origin OPFS access.
 * After calling this, navigate to '/' to load the TUI with the seeded config.
 * 
 * @param page - Playwright page
 * @param configToml - TOML config content (defaults to DEFAULT_TEST_CONFIG)
 */
export async function seedConfig(page: Page, configToml: string = DEFAULT_TEST_CONFIG): Promise<void> {
    // Navigate to the wasm-test page to get OPFS access if not already on localhost
    const currentUrl = page.url();
    if (!currentUrl.includes('localhost') && !currentUrl.includes('127.0.0.1')) {
        await page.goto('/wasm-test.html');
        // Wait for page to be ready enough for OPFS
        await page.waitForLoadState('domcontentloaded');
    }

    await page.evaluate(async (content) => {
        // Get OPFS root
        const root = await navigator.storage.getDirectory();

        // Create .config directory
        const configDir = await root.getDirectoryHandle('.config', { create: true });

        // Create web-agent subdirectory
        const webAgentDir = await configDir.getDirectoryHandle('web-agent', { create: true });

        // Create and write config.toml
        const fileHandle = await webAgentDir.getFileHandle('config.toml', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();

        console.log('[seedConfig] Config written to OPFS');
    }, configToml);
}

/**
 * Create a config TOML string with custom overrides.
 * 
 * @param overrides - Configuration overrides
 * @returns TOML config string
 */
export function makeConfig(overrides: {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
} = {}): string {
    const provider = overrides.provider ?? 'anthropic';
    const apiKey = overrides.apiKey ?? 'test-api-key-for-e2e-testing';
    const model = overrides.model ?? (provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o');
    const baseUrl = overrides.baseUrl ? `base_url = "${overrides.baseUrl}"` : '';

    return `
[providers]
default = "${provider}"

[providers.${provider}]
model = "${model}"
api_key = "${apiKey}"
${baseUrl}
api_format = "${provider === 'anthropic' ? 'anthropic' : 'openai'}"

[ui]
theme = "dark"
aux_panel = true
`;
}

/**
 * Clear any existing config from OPFS.
 * Useful for tests that need a clean slate.
 */
export async function clearConfig(page: Page): Promise<void> {
    await page.evaluate(async () => {
        try {
            const root = await navigator.storage.getDirectory();
            const configDir = await root.getDirectoryHandle('.config', { create: false });
            const webAgentDir = await configDir.getDirectoryHandle('web-agent', { create: false });
            await webAgentDir.removeEntry('config.toml');
            console.log('[clearConfig] Config removed from OPFS');
        } catch {
            // Directory or file doesn't exist, that's fine
        }
    });
}
