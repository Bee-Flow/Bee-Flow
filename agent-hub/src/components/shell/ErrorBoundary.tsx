import React from 'react';
import { reportClientError } from '../../utils/clientErrorReporter';
import useTranslation from '../../hooks/useTranslation';
import { logger } from '../../utils/logger';

/**
 * Two boundaries in one file:
 *
 *   <ErrorBoundary> — the "something went wrong" app-level catcher.
 *     Full-height friendly fallback with "reload" and error details.
 *     Use at the root (wraps <App />).
 *
 *   <MessageErrorBoundary> — the "one message failed" catcher.
 *     Tiny inline fallback so ONE bad message doesn't blank the conversation.
 *     Use around <MessageItem />.
 *
 * Both catch render errors and lifecycle throws. They do NOT catch errors in
 * event handlers, async code, or setTimeout — those need their own try/catch.
 *
 * componentDidCatch fires once per caught error. We hand off to
 * `reportClientError`, which redacts tokens/keys from the payload before
 * POSTing and queues to IndexedDB if the network is down (drained on next
 * app mount via `drainErrorQueue`).
 */

interface RootFallbackProps {
    error: Error | null;
    info: React.ErrorInfo | null;
    onReload: React.MouseEventHandler<HTMLButtonElement>;
    onReset: React.MouseEventHandler<HTMLButtonElement>;
}

function RootFallback({ error, info, onReload, onReset }: RootFallbackProps) {
    const { t } = useTranslation();
    return (
        <div
            role="alert"
            className="min-h-[100vh] [display:flex] [align-items:center] [justify-content:center] [padding:24px] [background:var(--bg-primary,#fff)] [color:var(--text-primary,#111)]"
        >
            <div className="max-w-[540px] w-[100%]">
                <div className="[font-size:32px] [margin-bottom:8px]">⚠️</div>
                <h1 className="[font-size:20px] [font-weight:600] [margin-bottom:8px]">
                    {t('error.something_went_wrong', 'Something went wrong')}
                </h1>
                <p className="[font-size:14px] [color:var(--text-secondary,#555)] [margin-bottom:16px]">
                    {t('error.app_crashed', "The app hit an unexpected error and couldn't continue. Reloading usually fixes it.")}
                </p>
                <div className="[display:flex] [gap:8px] [margin-bottom:16px]">
                    <button
                        onClick={onReload}
                        className="[padding:8px_16px] [border-radius:8px] [background:var(--text-primary,#111)] [color:var(--bg-primary,#fff)] [border:none] [cursor:pointer] [font-size:14px] [font-weight:500]"
                    >
                        {t('error.reload_page', 'Reload page')}
                    </button>
                    <button
                        onClick={onReset}
                        className="[padding:8px_16px] [border-radius:8px] [background:transparent] [color:var(--text-primary,#111)] [border:1px_solid_var(--border-default,#ccc)] [cursor:pointer] [font-size:14px]"
                    >
                        {t('error.try_again', 'Try again')}
                    </button>
                </div>
                <details className="[font-size:12px] [color:var(--text-tertiary,#888)]">
                    <summary className="[cursor:pointer]">{t('error.details', 'Error details')}</summary>
                    <pre className="[margin-top:8px] [padding:8px] [background:var(--bg-tertiary,#f4f4f4)] [border-radius:4px] [overflow:auto] max-h-[240px] [font-size:11px]">
                        {String(error?.message || error)}
                        {error?.stack ? `\n\n${error.stack}` : ''}
                        {info?.componentStack ? `\n\nComponent stack:${info.componentStack}` : ''}
                    </pre>
                </details>
            </div>
        </div>
    
    );
}

interface ErrorBoundaryProps {
    label?: string;
    children?: React.ReactNode;
}

interface ErrorBoundaryState {
    error: Error | null;
    info: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { error: null, info: null };
    }

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        this.setState({ info });
        reportClientError(this.props.label || 'root', error, info);
    }

    handleReload = () => {
        try { window.location.reload(); } catch (err) { logger.debug('ignore', err); }
    };

    handleReset = () => {
        this.setState({ error: null, info: null });
    };

    render() {
        if (!this.state.error) return this.props.children;

        const { error, info } = this.state;
        return <RootFallback error={error} info={info} onReload={this.handleReload} onReset={this.handleReset} />;
    }
}

/**
 * Lightweight per-message boundary. Swallows a render error for a single
 * message and renders a small placeholder so the rest of the conversation
 * keeps working. Offers a "copy raw" so the user can send us the JSON blob
 * that broke.
 */
function MessageFallback({ onCopy }: { onCopy: React.MouseEventHandler<HTMLButtonElement> }) {
    const { t } = useTranslation();
    return (

        <div
            role="alert"
            className="my-2 px-3 py-2 rounded-lg text-sm [background:var(--bg-tertiary,rgba(255,0,0,0.05))] [border:1px_solid_var(--border-default,rgba(255,0,0,0.15))] [color:var(--text-secondary,#555)]!"
        >
            <div className="[display:flex] [align-items:center] [gap:8px]">
                <span>⚠️</span>
                <span>{t('error.message_render_failed', 'This message failed to render.')}</span>
                <button
                    onClick={onCopy}
                    className="[margin-left:auto] [font-size:11px] [padding:2px_8px] [border-radius:4px] [background:transparent] [border:1px_solid_var(--border-default,#ccc)] [cursor:pointer] [color:inherit]"
                    title={t('error.copy_raw_title', 'Copy raw message JSON')}
                >
                    {t('error.copy_raw', 'Copy raw')}
                </button>
            </div>
        </div>
    );
}

interface MessageErrorBoundaryProps {
    msg?: unknown;
    children?: React.ReactNode;
}

interface MessageErrorBoundaryState {
    error: Error | null;
}

export class MessageErrorBoundary extends React.Component<MessageErrorBoundaryProps, MessageErrorBoundaryState> {
    constructor(props: MessageErrorBoundaryProps) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        reportClientError('message', error, info);
    }

    handleCopy = () => {
        try {
            const raw = JSON.stringify(this.props.msg || {}, null, 2);
            navigator.clipboard?.writeText(raw);
        } catch (err) { logger.debug('ignore', err); }
    };

    render() {
        if (!this.state.error) return this.props.children;
        return <MessageFallback onCopy={this.handleCopy} />;
    }
}

export default ErrorBoundary;
