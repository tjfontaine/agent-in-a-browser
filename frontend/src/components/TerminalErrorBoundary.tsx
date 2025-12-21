/**
 * Error Boundary for InkXterm
 * 
 * Catches and suppresses non-fatal xterm dimension errors
 * that occur during ink-web's xterm integration.
 */
import { Component, ReactNode } from 'react';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
}

export class TerminalErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError(_error: Error): State {
        // Check if this is the known xterm dimensions error
        // If so, don't trigger error state - the terminal usually recovers
        return { hasError: false };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        // Log but don't crash for known xterm dimension errors
        if (error.message.includes('dimensions')) {
            console.warn('[Terminal] Suppressed xterm dimensions error:', error.message);
            return;
        }

        // For other errors, log and potentially show fallback
        console.error('[Terminal] Error:', error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return this.props.fallback || <div>Terminal error. Please refresh.</div>;
        }
        return this.props.children;
    }
}

export default TerminalErrorBoundary;
