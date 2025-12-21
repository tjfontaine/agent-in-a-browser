/**
 * /files Command
 */

import { CommandDef, colors } from './types';

export const filesCommand: CommandDef = {
    name: 'files',
    description: 'List files in sandbox',
    usage: '/files [path]',
    aliases: ['ls'],
    handler: (ctx, args) => {
        const path = args[0] || '/';
        ctx.output('system', `Listing files in ${path}...`, colors.dim);
        ctx.sendMessage(`List the files in ${path}`);
    },
};
