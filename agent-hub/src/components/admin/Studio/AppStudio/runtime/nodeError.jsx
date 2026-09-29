import { TriangleAlert } from 'lucide-react';
import React from 'react';

/**
 * App Studio runtime — per-node error containment. Every node renders inside
 * one of these (AppRenderer.RenderNode wraps them), so a component that throws
 * degrades to a card in its own grid cell instead of blanking the screen.
 */

/**
 * How many times a failed node is given another go when only its DATA changed.
 * Enough to cover "the value it reads had not arrived yet" (one or two frames),
 * small enough that a node throwing on every scope tick cannot spin.
 */
const MAX_SCOPE_RETRIES = 3;

const MAX_ERROR_CHARS = 160;

/**
 * The one line worth painting for a caught render error.
 *
 * A production React build minifies its invariants to a bare code plus a
 * decoder URL; the CODE is the part a human (or the AI builder reading a
 * screenshot) can act on, the URL is noise. A development build already throws
 * the real sentence, which is better still — "Too many re-renders. React limits
 * the number of renders…" says more than "#301" ever could.
 */
export function describeNodeError(error) {
    if (error == null) return null;
    const raw = typeof error === 'string' ? error : (error.message || String(error));
    const text = String(raw).trim();
    if (!text) return null;
    const minified = text.match(/(?:Minified React error #|invariant=)(\d+)/);
    const message = minified ? `React error #${minified[1]}` : text;
    return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS - 1)}…` : message;
}

/**
 * The card says WHICH component type failed, and in the editor WHY. It used to
 * say only "This component failed", which is exactly as much as a blank box:
 * the app builder AI, handed that card in a screenshot, could not tell a bad
 * prop from a render loop and drew the wrong conclusion about the runtime.
 *
 * It also recovers on its own. `signature` covers "the author corrected the
 * node"; `scope` covers the other half — a component that threw on the first
 * frame because the form values or query rows it reads did not exist yet used
 * to stay dead for the whole session, with no way back short of a reload.
 */
export default class NodeErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            failed: false,
            detail: null,
            signature: props.signature,
            scope: props.scope,
            scopeRetries: 0,
        };
    }

    static getDerivedStateFromError(error) {
        return { failed: true, detail: describeNodeError(error) };
    }

    static getDerivedStateFromProps(props, state) {
        // The wrapped node's content changed (e.g. the inspector corrected a
        // bad prop) — clear a prior failure so it re-renders instead of showing
        // the failure card forever. A node that is still broken throws again on
        // the next render and getDerivedStateFromError contains it once more.
        if (props.signature !== state.signature) {
            return {
                failed: false, detail: null, signature: props.signature, scope: props.scope, scopeRetries: 0,
            };
        }
        if (props.scope === state.scope) return null;
        // The node's DATA changed, not its definition. Worth one honest retry:
        // the throw may have been about a value that had not landed yet.
        if (!state.failed) return { scope: props.scope, scopeRetries: 0 };
        if (state.scopeRetries >= MAX_SCOPE_RETRIES) return { scope: props.scope };
        return { failed: false, detail: null, scope: props.scope, scopeRetries: state.scopeRetries + 1 };
    }

    componentDidCatch(error) {
        console.error(`[AppStudio] component '${this.props.type}' crashed:`, error);
    }

    render() {
        if (this.state.failed) {
            const type = this.props.type ? String(this.props.type) : null;
            // The error text is for whoever can act on it — the app's author in
            // the editor. An end user gets the plain sentence and the type.
            const detail = this.props.mode === 'edit' ? this.state.detail : null;
            return (
                <div
                    className="flex items-start gap-2 border border-dashed px-3 py-2 text-sm"
                    role="alert"
                    data-app-node-error={type || 'unknown'}
                    style={{
                        borderColor: 'var(--border-default)',
                        color: 'var(--text-muted)',
                        borderRadius: 'var(--app-radius)',
                    }}
                >
                    <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                    <span className="flex min-w-0 flex-col gap-0.5 text-left">
                        <span>This component failed</span>
                        {type ? (
                            <span className="text-xs" data-app-node-error-type="true">{type}</span>
                        ) : null}
                        {detail ? (
                            <span className="text-xs break-words" data-app-node-error-detail="true">{detail}</span>
                        ) : null}
                    </span>
                </div>
            );
        }
        return this.props.children;
    }
}
