import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';

import useSidePanelState from './useSidePanelState';

// jsdom ships no matchMedia. The hook reads it to decide whether there is room
// for a panel at all, so the tests own it and default to desktop.
let viewportIsMobile = false;
beforeEach(() => {
    viewportIsMobile = false;
    window.matchMedia = (query) => ({
        matches: /max-width:\s*767px/.test(query) ? viewportIsMobile : !viewportIsMobile,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
    });
});

/**
 * The right-hand slot now has four possible occupants — notebook, Gamma
 * preview, webpage, document — and exactly one of them may be on screen. That
 * invariant is not enforced by the layout (ChatSidePanels renders whichever
 * conditions are true), so it lives here, in the state. A fourth occupant added
 * without updating the other three's setters is the bug this file exists for:
 * two panels in one column, or a panel that cannot be closed.
 */

describe('useSidePanelState — the document panel joins the shared slot', () => {
    it('starts closed', () => {
        const { result } = renderHook(() => useSidePanelState());
        expect(result.current.sidePanelDocumentId).toBeNull();
    });

    it('opening a document evicts the notebook, the gamma preview and the webpage', () => {
        const { result } = renderHook(() => useSidePanelState());
        act(() => {
            result.current.setShowNotebook(true);
            result.current.setShowGammaPreview(true);
            result.current.openWebpageInSidePanel('w1');
        });
        act(() => result.current.openDocumentInSidePanel('d1'));

        expect(result.current.sidePanelDocumentId).toBe('d1');
        expect(result.current.showNotebook).toBe(false);
        expect(result.current.showGammaPreview).toBe(false);
        expect(result.current.sidePanelWebpageId).toBeNull();
    });

    it('opening a webpage or the notebook evicts the document', () => {
        // The other direction, which is the half that gets forgotten.
        const { result } = renderHook(() => useSidePanelState());

        act(() => result.current.openDocumentInSidePanel('d1'));
        act(() => result.current.openWebpageInSidePanel('w1'));
        expect(result.current.sidePanelDocumentId).toBeNull();

        act(() => result.current.openDocumentInSidePanel('d2'));
        act(() => result.current.toggleNotebookPanel());
        expect(result.current.showNotebook).toBe(true);
        expect(result.current.sidePanelDocumentId).toBeNull();
    });

    it('closeSidePreview clears the document too', () => {
        // Whatever closes "the side preview" must close all four, or the slot
        // keeps a tenant nobody can see a close button for.
        const { result } = renderHook(() => useSidePanelState());
        act(() => result.current.openDocumentInSidePanel('d1'));
        act(() => result.current.closeSidePreview());
        expect(result.current.sidePanelDocumentId).toBeNull();
    });

    it('closeDocumentPanel closes only the document', () => {
        const { result } = renderHook(() => useSidePanelState());
        act(() => result.current.openDocumentInSidePanel('d1'));
        act(() => result.current.closeDocumentPanel());
        expect(result.current.sidePanelDocumentId).toBeNull();
    });

    it('ignores an open with no id rather than blanking the slot', () => {
        const { result } = renderHook(() => useSidePanelState());
        act(() => result.current.openDocumentInSidePanel('d1'));
        act(() => result.current.openDocumentInSidePanel(null));
        expect(result.current.sidePanelDocumentId).toBe('d1');
    });

    it('claims beeflow:open-document-side so the link card knows not to navigate', () => {
        const { result } = renderHook(() => useSidePanelState());
        let defaultPrevented;
        act(() => {
            const evt = new CustomEvent('beeflow:open-document-side', {
                detail: { id: 'd9' },
                cancelable: true,
            });
            // dispatchEvent returns false once a listener calls preventDefault.
            defaultPrevented = !window.dispatchEvent(evt);
        });
        expect(defaultPrevented).toBe(true);
        expect(result.current.sidePanelDocumentId).toBe('d9');
    });

    it('does not claim an event with no id', () => {
        const { result } = renderHook(() => useSidePanelState());
        let defaultPrevented;
        act(() => {
            const evt = new CustomEvent('beeflow:open-document-side', { detail: {}, cancelable: true });
            defaultPrevented = !window.dispatchEvent(evt);
        });
        expect(defaultPrevented).toBe(false);
        expect(result.current.sidePanelDocumentId).toBeNull();
    });

    it('declines the event on a phone, so the card navigates instead', () => {
        // ChatSidePanels renders nothing below 768px. Claiming the event there
        // would set an id nothing displays, and the tap would read as a dead
        // link — worse than the full-screen view the fallback reaches.
        viewportIsMobile = true;
        const { result } = renderHook(() => useSidePanelState());
        let defaultPrevented;
        act(() => {
            const evt = new CustomEvent('beeflow:open-document-side', {
                detail: { id: 'd9' },
                cancelable: true,
            });
            defaultPrevented = !window.dispatchEvent(evt);
        });
        expect(defaultPrevented).toBe(false);
        expect(result.current.sidePanelDocumentId).toBeNull();
    });

    it('stops listening once unmounted', () => {
        // Otherwise every chat that has ever been open answers the next click.
        const { result, unmount } = renderHook(() => useSidePanelState());
        const before = result.current.sidePanelDocumentId;
        unmount();
        const evt = new CustomEvent('beeflow:open-document-side', { detail: { id: 'd1' }, cancelable: true });
        expect(window.dispatchEvent(evt)).toBe(true); // nobody claimed it
        expect(before).toBeNull();
    });
});
