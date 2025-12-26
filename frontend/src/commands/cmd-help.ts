/**
 * /help Command
 */

import { CommandDef, colors } from './types';

export const helpCommand: CommandDef = {
    name: 'help',
    description: 'Show available commands',
    handler: (ctx) => {
        // This will be populated dynamically with all registered commands
        ctx.output('system', '', undefined);
        ctx.output('system', 'Commands:', colors.cyan);
        ctx.output('system', '  /help              - Show this help');
        ctx.output('system', '  /clear             - Clear conversation');
        ctx.output('system', '  /files [path]      - List files in sandbox');
        ctx.output('system', '', undefined);
        ctx.output('system', 'Plan Mode:', colors.cyan);
        ctx.output('system', '  /plan [desc]       - Enter plan mode, optionally start planning');
        ctx.output('system', '  /mode [normal|plan] - View/switch agent mode');
        ctx.output('system', '  Ctrl+P             - Toggle plan mode');
        ctx.output('system', '  Ctrl+N             - Switch to normal mode');
        ctx.output('system', '', undefined);
        ctx.output('system', 'AI Provider:', colors.cyan);
        ctx.output('system', '  /provider          - Configure provider and API keys');
        ctx.output('system', '  /model             - View/switch AI model');
        ctx.output('system', '  /panel [show|hide] - Toggle auxiliary panel');
        ctx.output('system', '', undefined);
        ctx.output('system', 'MCP Commands:', colors.cyan);
        ctx.output('system', '  /mcp               - Show MCP status');
        ctx.output('system', '  /mcp list          - List servers with IDs');
        ctx.output('system', '  /mcp add <url>     - Add remote MCP server');
        ctx.output('system', '  /mcp remove <id>   - Remove remote server');
        ctx.output('system', '  /mcp auth <id>     - Authenticate with OAuth');
        ctx.output('system', '  /mcp connect <id>  - Connect to remote server');
        ctx.output('system', '  /mcp disconnect <id> - Disconnect from server');
        ctx.output('system', '');
    },
};
