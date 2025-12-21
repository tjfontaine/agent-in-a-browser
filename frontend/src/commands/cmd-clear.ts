/**
 * /clear Command
 */

import { CommandDef } from './types';

export const clearCommand: CommandDef = {
    name: 'clear',
    description: 'Clear conversation history',
    aliases: ['cls'],
    handler: (ctx) => {
        ctx.clearHistory();
    },
};
