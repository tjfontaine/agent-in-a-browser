/**
 * Agent Mode Types and Configuration
 * 
 * Defines the planning mode types and tool filtering rules.
 * In plan mode, the agent operates read-only except for the plan file.
 */

/**
 * Agent operating modes:
 * - 'normal': Full access to all tools
 * - 'plan': Read-only mode for planning, only /plan.md is writable
 * - 'shell': Direct shell command execution (no AI processing)
 * - 'interactive': Raw terminal mode for TUI applications (editors, etc.)
 */
export type AgentMode = 'normal' | 'plan' | 'shell' | 'interactive';

/**
 * Shell mode prompt indicator
 */
export const SHELL_MODE_PROMPT = '$ ';

/**
 * Commands that exit shell mode
 */
export const SHELL_EXIT_COMMANDS = ['exit', 'logout'];

/**
 * The plan file path - the only file writable in plan mode
 */
export const PLAN_FILE_PATH = '/plan.md';

/**
 * Tools allowed in plan mode (read-only operations)
 */
export const PLAN_MODE_ALLOWED_TOOLS = [
    'read_file',
    'list',
    'grep',
    'shell_eval',   // Only read-only commands will be allowed
    'task_write',   // For showing plan progress
];

/**
 * Tools blocked in plan mode
 * Exception: write_file is allowed ONLY for /plan.md
 */
export const PLAN_MODE_BLOCKED_TOOLS = [
    'write_file',
    'edit_file',
];

/**
 * Check if a tool is allowed in plan mode
 */
export function isToolAllowedInPlanMode(
    toolName: string,
    toolArgs?: Record<string, unknown>
): { allowed: boolean; reason?: string } {
    // Blocked tools
    if (PLAN_MODE_BLOCKED_TOOLS.includes(toolName)) {
        // Exception: allow write_file to plan.md
        if (toolName === 'write_file') {
            const path = toolArgs?.path as string | undefined;
            if (path === PLAN_FILE_PATH) {
                return { allowed: true };
            }
        }
        return {
            allowed: false,
            reason: `Tool "${toolName}" is blocked in plan mode. Only read operations are allowed. Use /mode normal or Ctrl+N to switch to normal mode.`,
        };
    }

    return { allowed: true };
}

/**
 * Plan mode system prompt addition
 */
export const PLAN_MODE_SYSTEM_PROMPT = `
=== PLAN MODE ACTIVE ===
You are in read-only planning mode. You may:
- Read files with read_file
- List directories with list
- Search with grep
- Run read-only shell commands (ls, cat, find, echo)
- Track tasks with task_write

You MUST NOT:
- Create, modify, or delete files (except /plan.md)
- Execute write operations

Write your implementation plan to /plan.md (the ONLY writable file).
Structure your plan with clear numbered steps, files to modify, and expected changes.
When finished, output: "Plan ready for review. Type 'go' or 'yes' to execute."
`;
