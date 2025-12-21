/**
 * Application Constants
 * 
 * Centralized configuration values used across the frontend.
 */

/** Backend API URL for anthropic proxy */
export const API_URL = '';  // Same origin - Vite proxies to backend

/** 
 * Anthropic API key - loaded from environment or uses a dummy key.
 * The backend proxy handles the actual authentication.
 */
export const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || 'dummy-key-for-proxy';

/** Terminal prompt string with cyan arrow */
export const PROMPT = '\x1b[36m❯\x1b[0m ';
