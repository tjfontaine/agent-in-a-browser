/**
 * Commands Module
 * 
 * Barrel export for command-related functionality.
 */

// MCP state management
export { setMcpState, isMcpInitialized, getMcpStatusData } from './mcp';

// Command parser
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

