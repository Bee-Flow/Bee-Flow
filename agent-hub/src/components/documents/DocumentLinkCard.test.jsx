import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DocumentLinkCard, { extractDocumentId } from './DocumentLinkCard';

/**
 * The card is what turns the model's closing "[<name>](<url>)" into something
 * to click. If the href pattern and the extractor ever disagree, the link
 * silently renders as a plain anchor to a path the SPA does not serve — which
 * looks like the feature working right up until somebody clicks it.
 */

beforeEach(cleanup);

describe('extractDocumentId', () => {
    it('reads the id out of the canonical path', () => {
        expect(extractDocumentId('/app/studio/documents/abc-123')).toBe('abc-123');
    });

    it('answers null for anything that is not one', () => {
        expect(extractDocumentId('/app/studio/webpages/abc')).toBeNull();
        expect(extractDocumentId('/app/studio/documents')).toBeNull();
        expect(extractDocumentId('https://evil.test/app/studio/documents/x')).toBe('x');
        expect(extractDocumentId(null)).toBeNull();
        expect(extractDocumentId(42)).toBeNull();
    });
});

describe('<DocumentLinkCard>', () => {
    it('shows the label the model wrote', () => {
        render(<DocumentLinkCard href="/app/studio/documents/d1" label="Factuur 2026-014" />);
        expect(screen.getByTestId('document-link-card').textContent).toContain('Factuur 2026-014');
    });

    it('asks the chat shell to host the document in the side panel', () => {
        // The whole point: the AI drafts an invoice and you fix a number, so
        // the document has to arrive BESIDE the conversation, not instead of it.
        const push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
        const seen = [];
        const listener = (e) => { seen.push(e.detail); e.preventDefault(); };
        window.addEventListener('beeflow:open-document-side', listener);

        render(<DocumentLinkCard href="/app/studio/documents/d1" label="X" />);
        fireEvent.click(screen.getByTestId('document-link-card'));

        expect(seen).toEqual([{ id: 'd1', href: '/app/studio/documents/d1' }]);
        // Claimed → no navigation, so the conversation stays on screen.
        expect(push).not.toHaveBeenCalled();

        window.removeEventListener('beeflow:open-document-side', listener);
        push.mockRestore();
    });

    it('falls back to navigation when nothing claims the event', () => {
        // A message rendered outside the chat shell — a cowork run, a shared
        // transcript — has no side panel to open. The link must still go
        // somewhere rather than doing nothing.
        const push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
        const dispatch = vi.spyOn(window, 'dispatchEvent');
        render(<DocumentLinkCard href="/app/studio/documents/d1" label="X" />);
        fireEvent.click(screen.getByTestId('document-link-card'));

        expect(push).toHaveBeenCalledWith({ page: 'studio' }, '', '/app/studio/documents/d1');
        // A popstate is what the SPA router listens for; without it the URL
        // would change and the screen would not.
        expect(dispatch.mock.calls.some(([e]) => e.type === 'popstate')).toBe(true);
        push.mockRestore();
        dispatch.mockRestore();
    });

    it('a listener that does NOT claim the event still gets navigation', () => {
        // Guards the cancellable contract: only preventDefault() counts as
        // "handled". A listener that merely observes must not swallow the click.
        const push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
        const listener = () => { /* observes, does not claim */ };
        window.addEventListener('beeflow:open-document-side', listener);
        render(<DocumentLinkCard href="/app/studio/documents/d1" label="X" />);
        fireEvent.click(screen.getByTestId('document-link-card'));
        expect(push).toHaveBeenCalled();
        window.removeEventListener('beeflow:open-document-side', listener);
        push.mockRestore();
    });

    it('falls back to the section when the href carries no id', () => {
        const push = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
        render(<DocumentLinkCard href="/app/studio/documents" label="X" />);
        fireEvent.click(screen.getByTestId('document-link-card'));
        expect(push).toHaveBeenCalledWith({ page: 'studio' }, '', '/app/studio/documents');
        push.mockRestore();
    });
});
