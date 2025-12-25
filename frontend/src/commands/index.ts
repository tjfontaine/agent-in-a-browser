/**
 * Commands Module
 * 
 * Barrel export for command-related functionality.
 */

// Legacy xterm router (for backward compat)
export { handleSlashCommand } from './router';
export { handleMcpCommand, showMcpStatus, setMcpState, isMcpInitialized, getMcpStatusData } from './mcp';
export { parseSlashCommand, COMMANDS, getCommandUsage } from './Parser';

// New modular command system  
export {
    executeCommand,
    getCommandCompletions,
    registerCommand,
    getRegisteredCommands,
    type CommandDef,
    type CommandContext,
    type OutputFn,
    colors,
} from './registry';
