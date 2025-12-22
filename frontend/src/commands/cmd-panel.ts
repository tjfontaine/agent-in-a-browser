/**
 * Panel Command
 * 
 * Toggle or control the auxiliary panel visibility.
 * 
 * Usage:
 *   /panel       - Toggle visibility
 *   /panel show  - Show the panel
 *   /panel hide  - Hide the panel
 */

import { CommandDef, CommandContext, colors } from './types';
import { toggleAuxPanel, setAuxPanelVisible, isAuxPanelVisible } from '../components/SplitLayout';

export const panelCommand: CommandDef = {
    name: 'panel',
    description: 'Toggle or control the auxiliary panel',
    usage: '/panel [show|hide]',

    subcommands: [
        {
            name: 'show',
            description: 'Show the auxiliary panel',
            handler: async (ctx: CommandContext) => {
                setAuxPanelVisible(true);
                ctx.output('system', '📋 Panel shown', colors.cyan);
            },
        },
        {
            name: 'hide',
            description: 'Hide the auxiliary panel',
            handler: async (ctx: CommandContext) => {
                setAuxPanelVisible(false);
                ctx.output('system', '📋 Panel hidden', colors.cyan);
            },
        },
    ],

    handler: async (ctx: CommandContext) => {
        toggleAuxPanel();
        const visible = isAuxPanelVisible();
        ctx.output('system', `📋 Panel ${visible ? 'shown' : 'hidden'}`, colors.cyan);
    },
};
