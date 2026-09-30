import { act, render, screen, waitFor } from '@testing-library/react';
import React, { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../test/queryWrapper';

/**
 * The canvas and its frame: messages wait until the bridge is up, a flush
 * resolves only after the frame reported its last text, other people's
 * sections are sent when they change (not on every render), and only the
 * frame's own window is listened to.
 */

const { api } = vi.hoisted(() => ({ api: { fetchPreviewHtml: vi.fn() } }));
vi.mock('./documentsApi', () => api);

const { default: DocumentCanvas } = await import('./DocumentCanvas');
type Handle = import('./DocumentCanvas').CanvasHandle;

beforeEach(() => {
    api.fetchPreviewHtml.mockReset().mockResolvedValue('<p>Document</p>');
});

const frameOf = () => screen.getByTestId('document-frame') as HTMLIFrameElement;
const fromFrame = (data: unknown, source: Window | null = frameOf().contentWindow) =>
    act(() => { window.dispatchEvent(new MessageEvent('message', { source, data })); });

async function mount(props: Partial<React.ComponentProps<typeof DocumentCanvas>> = {}) {
    const ref = createRef<Handle>();
    const onDirty = vi.fn();
    const utils = render(withQueryClient(<DocumentCanvas ref={ref} documentId="d1" editing reloadKey={0} onDirty={onDirty} {...props} />));
    await waitFor(() => expect(frameOf().srcdoc).toContain('Document'));
    const post = vi.spyOn(frameOf().contentWindow as Window, 'postMessage');
    return { ref, onDirty, post, ...utils };
}

describe('DocumentCanvas', () => {
    it('holds an insertion until the bridge is ready, then sends it with the mode and the theme', async () => {
        const { ref, post } = await mount();
        ref.current!.insert('customer.name');
        expect(post).not.toHaveBeenCalled();
        fromFrame({ __beeflowDocReady: true });
        const sent = post.mock.calls.map(([m]) => Object.keys(m as object)[0]);
        expect(sent).toEqual(['__beeflowDocEdit', '__beeflowDocTheme', '__beeflowDocInsert']);
        expect(post).toHaveBeenCalledWith({ __beeflowDocInsert: true, key: 'customer.name' }, '*');
    });

    it('a flush resolves only after the frame reported its newest text', async () => {
        const { ref, onDirty, post } = await mount();
        fromFrame({ __beeflowDocReady: true });
        const done = vi.fn();
        const pending = ref.current!.flush().then(done);
        const request = post.mock.calls.map(([m]) => m as { __beeflowDocFlush?: boolean; requestId?: string }).find((m) => m.__beeflowDocFlush)!;
        expect(done).not.toHaveBeenCalled();
        fromFrame({ __beeflowDocDirty: true, html: '<p>Newest</p>', requestId: request.requestId });
        await pending;
        expect(onDirty).toHaveBeenCalledWith('<p>Newest</p>');
        expect(onDirty.mock.invocationCallOrder[0]).toBeLessThan(done.mock.invocationCallOrder[0]);
    });

    it('reports what the frame says, and ignores a window that is not the frame', async () => {
        const onOutline = vi.fn();
        const onKey = vi.fn();
        const onCaret = vi.fn();
        await mount({ onOutline, onKey, onCaret });
        fromFrame({ __beeflowDocOutline: true, items: [{ index: 0, level: 1, text: 'Intro', sectionId: null }] });
        fromFrame({ __beeflowDocKey: true, key: 'history' });
        fromFrame({ __beeflowDocCaret: true, sectionId: 'pricing' });
        fromFrame({ __beeflowDocCaret: true, sectionId: 'forged' }, window);
        expect(onOutline).toHaveBeenCalledWith([{ index: 0, level: 1, text: 'Intro', sectionId: null }]);
        expect(onKey).toHaveBeenCalledWith('history');
        expect(onCaret.mock.calls).toEqual([['pricing']]);
    });

    it('sends other people\'s sections when they change, not on every render', async () => {
        const peers = [{ sectionId: 'pricing', label: 'Anna is editing', colour: '#0284c7' }];
        const client = (await import('../../test/queryWrapper')).testQueryClient();
        const ref = createRef<Handle>();
        const view = (list: typeof peers) => withQueryClient(<DocumentCanvas ref={ref} documentId="d1" editing reloadKey={0} onDirty={vi.fn()} peers={list} />, client);
        const { rerender } = render(view(peers));
        await waitFor(() => expect(frameOf().srcdoc).toContain('Document'));
        const post = vi.spyOn(frameOf().contentWindow as Window, 'postMessage');
        fromFrame({ __beeflowDocReady: true });
        expect(post).toHaveBeenCalledWith({ __beeflowDocPeers: true, peers }, '*');
        post.mockClear();
        rerender(view([...peers]));
        expect(post).not.toHaveBeenCalled();
        rerender(view([]));
        expect(post).toHaveBeenCalledWith({ __beeflowDocPeers: true, peers: [] }, '*');
    });

    it('puts changes into sections and answers which it could not', async () => {
        const { ref, post } = await mount();
        fromFrame({ __beeflowDocReady: true });
        const result = ref.current!.patchSections({ pricing: '<p>new</p>' });
        expect(post).toHaveBeenCalledWith({ __beeflowDocPatch: true, sections: { pricing: '<p>new</p>' } }, '*');
        fromFrame({ __beeflowDocPatched: true, applied: [], missing: ['pricing'] });
        await expect(result).resolves.toEqual({ applied: [], missing: ['pricing'] });
    });

    it('says so when the preview cannot be loaded', async () => {
        api.fetchPreviewHtml.mockRejectedValue(Object.assign(new Error('HTTP 500'), { status: 500 }));
        const onError = vi.fn();
        render(withQueryClient(<DocumentCanvas documentId="d1" editing reloadKey={0} onDirty={vi.fn()} onError={onError} />));
        await waitFor(() => expect(onError).toHaveBeenCalledWith('Could not load the document preview.'), { timeout: 4000 });
    });
});
