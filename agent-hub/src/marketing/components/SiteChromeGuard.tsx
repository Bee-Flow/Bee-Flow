import React from 'react';
import { reportClientError } from '../../utils/clientErrorReporter';

interface SiteChromeGuardProps {
    /** Names the part in the error report ("header", "footer"). */
    label: string;
    /** Changes when the data behind the part changes, so a fixed setting recovers without a reload. */
    resetKey?: unknown;
    children?: React.ReactNode;
}

interface SiteChromeGuardState {
    failed: boolean;
}

/**
 * Error boundary around one part of the public site's chrome (header or
 * footer). The chrome is optional, the page is not: when a stored setting
 * makes the part throw while rendering, the part disappears and the page
 * stays on screen, instead of one bad setting blanking every page.
 */
export default class SiteChromeGuard extends React.Component<SiteChromeGuardProps, SiteChromeGuardState> {
    state: SiteChromeGuardState = { failed: false };

    static getDerivedStateFromError(): SiteChromeGuardState {
        return { failed: true };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        void reportClientError(`site-${this.props.label}`, error, info);
    }

    componentDidUpdate(prev: SiteChromeGuardProps) {
        if (this.state.failed && prev.resetKey !== this.props.resetKey) {
            this.setState({ failed: false });
        }
    }

    render() {
        return this.state.failed ? null : this.props.children;
    }
}
