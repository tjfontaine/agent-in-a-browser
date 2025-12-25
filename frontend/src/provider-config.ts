/**
 * Provider Configuration Facade
 * 
 * This file is now a facade that delegates to the new modular configuration system.
 * It re-exports everything from existing `src/config` implementation.
 * 
 * New code should import from `src/config` directly.
 * Existing imports for `./provider-config` will continue to work but use the new Zustand store.
 */

export * from './config';
