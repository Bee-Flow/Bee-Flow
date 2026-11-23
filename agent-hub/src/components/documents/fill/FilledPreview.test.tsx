import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

import type { FillDocument, FilledPreviewPage } from '@/api/templateFillApi';
import FilledPreview from './FilledPreview';
import PreviewButton from './PreviewButton';

/**
 * The document with what is filled in, next to its form: the page in a frame
 * without an origin, drawn again behind the one on screen, at the reader's
 * place. jsdom runs no script inside a frame, so what the frame's own script
 * would say is said here (`frameSays`).
 */

const page = (html: string, gaps: string[] = []): FilledPreviewPage => ({ html, gaps });
const FIRST = '<html><body><p>Offer for [Client name]</p></body></html>';
const SECOND = '<html><body><p>Offer for Van Dijk</p></body></html>';

function client() {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
const within = (qc: QueryClient, ui: ReactNode) => <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;

const shown = () => screen.getByTestId('filled-preview-frame') as HTMLIFrameElement;
const loading = () => screen.findByTestId('filled-preview-next') as Promise<HTMLIFrameElement>;
const frames = () => screen.getByTestId('filled-preview').querySelectorAll('iframe');

function frameSays(frame: HTMLIFrameElement, data: Record<string, unknown>) {
    act(() => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data })); });
}
const heard = (frame: HTMLIFrameElement) => vi.spyOn(frame.contentWindow as Window, 'postMessage');

/** The first page, up and on screen. */
async function firstPageShown(load: (id: string) => Promise<FilledPreviewPage>, spot = '') {
    const qc = client();
    const view = render(within(qc, <FilledPreview documentId="d1" revision="v1" load={load} spot={spot} />));
    const frame = await loading();
    frameSays(frame, { __beeflowDocReady: true });
    await waitFor(() => expect(shown()).toBe(frame));
    const again = (revision: string, nextSpot = spot) => view.rerender(within(qc, <FilledPreview documentId="d1" revision={revision} load={load} spot={nextSpot} />));
    return { frame, again };
}

describe('the document with what is filled in', () => {
    it('shows the page in a frame without an origin, and says what is still needed', async () => {
        const load = vi.fn().mockResolvedValue(page(FIRST, ['client']));
        render(within(client(), <FilledPreview documentId="d1" revision="v1" load={load} />));
        const frame = await loading();
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame.getAttribute('srcdoc')).toBe(FIRST);
        expect(screen.getByTestId('filled-preview-caption')).toHaveTextContent('1 field that is still needed is shown as [its name].');
        const post = heard(frame);
        frameSays(frame, { __beeflowDocReady: true });
        await waitFor(() => expect(shown()).toBe(frame));
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ __beeflowDocTheme: true, fit: true }), '*');
        // It is a picture: the frame is never made editable, and never asked for its content.
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ __beeflowDocEdit: true }), '*');
        expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ __beeflowDocFlush: true }), '*');
        expect(load).toHaveBeenCalledWith('d1');
    });

    it('a new revision loads behind the page on screen, and takes its place where the reader was', async () => {
        const load = vi.fn().mockResolvedValueOnce(page(FIRST, ['client'])).mockResolvedValueOnce(page(SECOND));
        const { frame: first, again } = await firstPageShown(load);
        frameSays(first, { __beeflowDocScrolled: true, y: 420 });

        again('v2');
        const next = await loading();
        expect(next.getAttribute('srcdoc')).toBe(SECOND);
        expect(shown()).toBe(first);
        expect(next).toHaveAttribute('aria-hidden', 'true');
        const post = heard(next);
        frameSays(next, { __beeflowDocReady: true });
        expect(post).toHaveBeenCalledWith({ __beeflowDocScroll: true, y: 420 }, '*');
        await waitFor(() => expect(shown()).toBe(next));
        expect(frames()).toHaveLength(1);
        expect(screen.getByTestId('filled-preview-caption')).toHaveTextContent('This is how the document reads with what is filled in.');
    });

    it('a message from another window is not the frame speaking', async () => {
        const load = vi.fn().mockResolvedValue(page(FIRST));
        render(within(client(), <FilledPreview documentId="d1" revision="v1" load={load} />));
        await loading();
        act(() => { window.dispatchEvent(new MessageEvent('message', { source: window, data: { __beeflowDocReady: true } })); });
        expect(screen.queryByTestId('filled-preview-frame')).not.toBeInTheDocument();
    });

    it('marks the field the person is at and brings it into view; a new page keeps the mark without scrolling', async () => {
        const load = vi.fn().mockResolvedValueOnce(page(FIRST, ['client'])).mockResolvedValueOnce(page(SECOND));
        const { frame: first, again } = await firstPageShown(load);
        const post = heard(first);
        again('v1', '[Client name]');
        await waitFor(() => expect(post).toHaveBeenCalledWith({ __beeflowDocReveal: true, quote: '[Client name]' }, '*'));
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ __beeflowDocAnchors: true, activeId: 'spot', anchors: [{ id: 'spot', quote: '[Client name]' }] }), '*');

        again('v2', '[Client name]');
        const next = await loading();
        const nextPost = heard(next);
        frameSays(next, { __beeflowDocReady: true });
        expect(nextPost).toHaveBeenCalledWith(expect.objectContaining({ __beeflowDocAnchors: true }), '*');
        expect(nextPost).not.toHaveBeenCalledWith(expect.objectContaining({ __beeflowDocReveal: true }), '*');
    });

    it('says so when the page cannot be read, and reads it again on request', async () => {
        const load = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(page(FIRST));
        render(within(client(), <FilledPreview documentId="d1" revision="v1" load={load} />));
        expect(await screen.findByRole('alert')).toHaveTextContent('The preview could not be shown.');
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect((await loading()).getAttribute('srcdoc')).toBe(FIRST);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
});

describe('"Preview" under a form in a chat', () => {
    const DOC: FillDocument = { id: 'd1', name: 'Offer Van Dijk', url: '/app/studio/documents/d1', format: 'pdf', editable: true, finished: false, fields: [], values: {} };

    it('saves what was typed first, then shows the page in a dialog, read anew each time it is opened', async () => {
        const order: string[] = [];
        const flush = vi.fn(async () => { order.push('saved'); });
        const load = vi.fn(async () => { order.push('read'); return page(FIRST); });
        render(within(client(), <PreviewButton doc={DOC} load={load} flush={flush} />));
        expect(screen.queryByTestId('template-fill-preview-dialog')).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
        expect((await loading()).getAttribute('srcdoc')).toBe(FIRST);
        expect(order).toEqual(['saved', 'read']);
        expect(screen.getByTestId('template-fill-preview-dialog')).toHaveTextContent('Offer Van Dijk');

        await userEvent.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByTestId('template-fill-preview-dialog')).not.toBeInTheDocument());
        await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
        await loading();
        expect(order).toEqual(['saved', 'read', 'saved', 'read']);
    });
});
