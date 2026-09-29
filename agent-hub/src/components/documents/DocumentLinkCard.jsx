import React from 'react';
import { FileText, ArrowRight } from 'lucide-react';

/**
 * Renders a clickable card for /app/studio/documents/:id links inside chat
 * messages, replacing the plain anchor MarkdownRenderer would emit. The sibling
 * of WebpageLinkCard, and deliberately the same shape: the model is told to end
 * its reply with "[<name>](<url>)", and this is what makes that land as
 * something to click rather than a path to read.
 *
 * Click behaviour mirrors WebpageLinkCard exactly: dispatch a cancellable
 * `beeflow:open-document-side` event so the chat shell can host the document in
 * the right-hand slot without losing the conversation. That is the point of the
 * whole feature — the AI drafts an invoice and you fix a number, and being sent
 * to a different screen to do it puts the chat and the artefact on opposite
 * sides of a navigation.
 *
 * If nothing claims the event (a message rendered outside the chat shell — a
 * cowork run, a shared transcript), fall back to plain in-app navigation to the
 * Studio section, so the link still goes somewhere.
 */
export function extractDocumentId(href) {
    if (typeof href !== 'string') return null;
    const m = href.match(/\/app\/studio\/documents\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
}

export default function DocumentLinkCard({ href, label }) {
    const handleClick = (e) => {
        e.preventDefault();
        const id = extractDocumentId(href);
        if (id) {
            const evt = new CustomEvent('beeflow:open-document-side', {
                detail: { id, href },
                cancelable: true,
            });
            // A listener claims the event with preventDefault(); dispatchEvent
            // then returns false. Nothing handled it → fall through to nav.
            const wasHandled = !window.dispatchEvent(evt);
            if (wasHandled) return;
        }
        const target = id ? `/app/studio/documents/${id}` : '/app/studio/documents';
        window.history.pushState({ page: 'studio' }, '', target);
        window.dispatchEvent(new PopStateEvent('popstate', { state: { page: 'studio' } }));
    };

    return (
        <button
            onClick={handleClick}
            className="inline-flex items-center gap-2 my-1 px-3 py-2 rounded-xl border text-left transition-all hover:shadow-md"
            style={{
                background: 'var(--bg-secondary)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-primary)',
                maxWidth: 320,
            }}
            data-testid="document-link-card"
        >
            <div
                className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: 'var(--brand-gradient, var(--accent-primary))' }}
            >
                <FileText size={14} color="white" />
            </div>
            <span className="flex-1 text-sm font-medium truncate">{label || 'Open document'}</span>
            <ArrowRight size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        </button>
    );
}
