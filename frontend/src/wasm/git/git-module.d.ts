/**
 * Git Module for Shell
 *
 * Provides git CLI functionality via isomorphic-git.
 * Integrates with our OPFS filesystem and lazy module loading system.
 * Uses async spawn/resolve pattern for proper async command execution.
 *
 * In sync mode (Safari), uses syncGitFs which returns immediately-resolved
 * promises backed by synchronous Atomics.wait operations.
 */
import type { CommandModule } from '../lazy-loading/lazy-modules';
/**
 * Git command module - implements CommandModule interface with spawn/resolve pattern
 */
export declare const command: CommandModule;
//# sourceMappingURL=git-module.d.ts.map