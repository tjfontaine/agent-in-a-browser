/**
 * Minimal DOM overlay showing relay connection status.
 *
 * Renders a small pill in the top-right corner of the page.
 * Only shown on session subdomains.
 * Click to expand and see Claude Code config + copy button.
 */

import type { RelayClient, RelayState, SessionInfo } from '@tjfontaine/edge-agent-session';
import { getMcpUrl } from '@tjfontaine/edge-agent-session';
import { getClaudeMcpAddCommand, getClaudeCodeConfig } from './session-utils.js';

const PILL_STYLES = `
    position: fixed;
    top: 8px;
    right: 8px;
    z-index: 10000;
    font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
    font-size: 11px;
    line-height: 1.4;
    color: #c0caf5;
    pointer-events: auto;
`;

const BADGE_STYLES = `
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 12px;
    background: rgba(26, 27, 38, 0.85);
    border: 1px solid rgba(192, 202, 245, 0.15);
    cursor: pointer;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    transition: border-color 0.2s;
    user-select: none;
`;

const STATE_COLORS: Record<RelayState, string> = {
    disconnected: '#f7768e',
    connecting: '#e0af68',
    connected: '#9ece6a',
    ready: '#7aa2f7',
};

export class RelayStatusOverlay {
    private container: HTMLDivElement;
    private badge: HTMLDivElement;
    private dot: HTMLSpanElement;
    private label: HTMLSpanElement;
    private panel: HTMLDivElement | null = null;
    private expanded = false;

    constructor(
        private relay: RelayClient,
        private session: SessionInfo,
    ) {
        // Container
        this.container = document.createElement('div');
        this.container.style.cssText = PILL_STYLES;

        // Badge (always visible)
        this.badge = document.createElement('div');
        this.badge.style.cssText = BADGE_STYLES;
        this.badge.addEventListener('click', () => this.toggle());
        this.badge.addEventListener('mouseenter', () => {
            this.badge.style.borderColor = 'rgba(192, 202, 245, 0.4)';
        });
        this.badge.addEventListener('mouseleave', () => {
            this.badge.style.borderColor = 'rgba(192, 202, 245, 0.15)';
        });

        // Status dot
        this.dot = document.createElement('span');
        this.dot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;';

        // Label
        this.label = document.createElement('span');

        this.badge.appendChild(this.dot);
        this.badge.appendChild(this.label);
        this.container.appendChild(this.badge);

        // Initial state
        this.updateState(relay.state);

        document.body.appendChild(this.container);
    }

    /** Call when relay state changes */
    updateState(state: RelayState): void {
        this.dot.style.backgroundColor = STATE_COLORS[state];
        this.label.textContent = state === 'ready' ? 'relay' : state;
    }

    /** Remove overlay from DOM */
    destroy(): void {
        this.container.remove();
    }

    private toggle(): void {
        if (this.expanded) {
            this.collapse();
        } else {
            this.expand();
        }
    }

    private expand(): void {
        if (this.panel) return;
        this.expanded = true;

        this.panel = document.createElement('div');
        this.panel.style.cssText = `
            margin-top: 6px;
            padding: 12px;
            border-radius: 8px;
            background: rgba(26, 27, 38, 0.95);
            border: 1px solid rgba(192, 202, 245, 0.15);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            max-width: 420px;
            word-break: break-all;
        `;

        const mcpUrl = getMcpUrl({ sid: this.session.sid, tenantId: this.session.tenantId });
        const addCmd = getClaudeMcpAddCommand(this.session.sid, this.session.tenantId);
        const configJson = getClaudeCodeConfig(this.session.sid, this.session.tenantId);

        this.panel.innerHTML = `
            <div style="margin-bottom: 8px; color: #7aa2f7; font-weight: 600;">MCP Endpoint</div>
            <div style="margin-bottom: 12px;">
                <code style="font-size: 10px; color: #9ece6a;">${mcpUrl}</code>
            </div>
            <div style="margin-bottom: 8px; color: #7aa2f7; font-weight: 600;">Claude Code</div>
            <pre style="font-size: 10px; margin: 0 0 8px; padding: 8px; background: rgba(0,0,0,0.3); border-radius: 4px; overflow-x: auto; white-space: pre-wrap;">${addCmd}</pre>
            <button id="relay-copy-cmd" style="${this.buttonStyle()}">Copy command</button>
            <details style="margin-top: 12px;">
                <summary style="cursor: pointer; color: #565f89; font-size: 10px;">JSON config</summary>
                <pre style="font-size: 10px; margin: 6px 0 0; padding: 8px; background: rgba(0,0,0,0.3); border-radius: 4px; overflow-x: auto; white-space: pre-wrap;">${configJson}</pre>
            </details>
        `;

        this.container.appendChild(this.panel);

        // Bind copy button
        const copyBtn = this.panel.querySelector('#relay-copy-cmd') as HTMLButtonElement;
        copyBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(addCmd).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => {
                    copyBtn.textContent = 'Copy command';
                }, 1500);
            });
        });

        // Close on outside click
        const onOutsideClick = (e: MouseEvent) => {
            if (!this.container.contains(e.target as Node)) {
                this.collapse();
                document.removeEventListener('click', onOutsideClick);
            }
        };
        // Delay to avoid catching the current click
        setTimeout(() => document.addEventListener('click', onOutsideClick), 0);
    }

    private collapse(): void {
        this.expanded = false;
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
        }
    }

    private buttonStyle(): string {
        return [
            'padding: 4px 10px',
            'font-size: 11px',
            'font-family: inherit',
            'border: 1px solid rgba(192, 202, 245, 0.2)',
            'border-radius: 4px',
            'background: rgba(122, 162, 247, 0.15)',
            'color: #7aa2f7',
            'cursor: pointer',
        ].join('; ');
    }
}

/**
 * Create and mount the status overlay if running on a session subdomain.
 */
export function mountRelayOverlay(relay: RelayClient, session: SessionInfo): RelayStatusOverlay {
    return new RelayStatusOverlay(relay, session);
}
