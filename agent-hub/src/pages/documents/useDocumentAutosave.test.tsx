import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Saving a designed document as it is typed (useDocumentAutosave): one save
 * per pause, every save made from the revision the text grew from and merged
 * by the server when that is no longer the newest, a conflict opened as
 * "compare and choose" and — the old dead end — every save after it made on
 * the right revision again.
 */

const { api } = vi.hoisted(() => ({ api: { updateDocument: vi.fn(), getDocument: vi.fn() } }));
vi.mock('./documentsApi', () => api);

const { default: useDocumentAutosave, AUTOSAVE_MS, readDraft } = await import('./useDocumentAutosave');

const DOC = { id: 'd1', userId: 'u1', name: 'Offer', docType: 'report', bodyHtml: '<p>a</p>', versionId: 'v1', editable: true };
const conflictError = (extra: Record<string, unknown> = {}) => Object.assign(new Error('This document changed while you were editing.'), { status: 409, code: 'document_conflict', ...extra });

function setup(onMerged = vi.fn(async () => true)) {
    const docRef = { current: { ...DOC } };
    const onSaved = vi.fn();
    const onReadOnly = vi.fn();
    const hook = renderHook(() => useDocumentAutosave({ documentId: 'd1', docRef, onSaved, onMerged, onReadOnly }));
    return { hook, docRef, onSaved, onMerged, onReadOnly };
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.updateDocument.mockReset();
    api.getDocument.mockReset();
    sessionStorage.clear();
});
afterEach(() => { vi.useRealTimers(); });

describe('useDocumentAutosave', () => {
    it('saves once after typing pauses, from the revision it grew from, asking for a merge', async () => {
        api.updateDocument.mockResolvedValue({ ...DOC, bodyHtml: '<p>abc</p>', versionId: 'v2' });
        const { hook } = setup();
        act(() => { hook.result.current.markDirty('<p>ab</p>'); hook.result.current.markDirty('<p>abc</p>'); });
        expect(hook.result.current.saveState).toBe('unsaved');
        expect(api.updateDocument).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10); });
        expect(api.updateDocument).toHaveBeenCalledTimes(1);
        expect(api.updateDocument).toHaveBeenCalledWith('d1', { bodyHtml: '<p>abc</p>', expectedVersionId: 'v1', merge: true });
        await waitFor(() => expect(hook.result.current.saveState).toBe('saved'));
        expect(readDraft('d1')).toBeNull();
    });

    it('keeps saving from the old revision until the frame shows what others saved', async () => {
        const onMerged = vi.fn(async () => false);
        api.updateDocument
            .mockResolvedValueOnce({ ...DOC, versionId: 'v3', merge: { merged: true, fromOthers: ['pricing'], othersOutsideSections: false } })
            .mockResolvedValueOnce({ ...DOC, versionId: 'v4' });
        const { hook } = setup(onMerged);
        act(() => hook.result.current.markDirty('<p>one</p>'));
        await act(async () => { await hook.result.current.flush(); });
        expect(onMerged).toHaveBeenCalledTimes(1);
        act(() => hook.result.current.markDirty('<p>two</p>'));
        await act(async () => { await hook.result.current.flush(); });
        expect(api.updateDocument.mock.calls[1][1].expectedVersionId).toBe('v1');
    });

    describe('typing while a save is merged with somebody else\'s section', () => {
        // Bob saved section B (v1 -> v2). Anna's save of section A leaves from
        // v1 and comes back merged as v3; while it was out she typed on, so the
        // frame reported a body that still has Bob's OLD section B.
        const STALE = '<section id="a">A2</section><section id="b">old B</section>';
        const FRESH = '<section id="a">A2</section><section id="b">Bob\'s B</section>';

        function mergedWhileTyping(reread?: (markDirty: (html: string) => void) => Promise<void>) {
            let answer!: (doc: unknown) => void;
            api.updateDocument
                .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }))
                .mockResolvedValue({ ...DOC, bodyHtml: FRESH, versionId: 'v4' });
            const docRef = { current: { ...DOC } };
            let markDirty: (html: string) => void = () => undefined;
            const hook = renderHook(() => useDocumentAutosave({
                documentId: 'd1', docRef, onSaved: vi.fn(), onReadOnly: vi.fn(),
                // The frame patched Bob's section in (Anna's caret was in A).
                onMerged: vi.fn(async () => true),
                reread: reread ? () => reread(markDirty) : undefined,
            }));
            markDirty = hook.result.current.markDirty;
            return { hook, answer: (doc: unknown) => answer(doc) };
        }

        it('a body read before the patch is never saved on the new revision: the frame is read again', async () => {
            const reread = vi.fn(async (markDirty: (html: string) => void) => { markDirty(FRESH); });
            const { hook, answer } = mergedWhileTyping(reread);
            act(() => hook.result.current.markDirty('<section id="a">A1</section><section id="b">old B</section>'));
            let saving!: Promise<void>;
            await act(async () => { saving = hook.result.current.flush(); });
            act(() => hook.result.current.markDirty(STALE));
            await act(async () => {
                answer({ ...DOC, bodyHtml: '<section id="a">A1</section><section id="b">Bob\'s B</section>', versionId: 'v3', merge: { merged: true, fromOthers: ['b'], othersOutsideSections: false } });
                await saving;
            });
            expect(reread).toHaveBeenCalledTimes(1);
            expect(api.updateDocument).toHaveBeenCalledTimes(2);
            expect(api.updateDocument.mock.calls[1][1]).toEqual({ bodyHtml: FRESH, expectedVersionId: 'v3', merge: true });
        });

        it('when the frame cannot be read again, the next save still merges from the old revision', async () => {
            const { hook, answer } = mergedWhileTyping();
            act(() => hook.result.current.markDirty('<section id="a">A1</section><section id="b">old B</section>'));
            let saving!: Promise<void>;
            await act(async () => { saving = hook.result.current.flush(); });
            act(() => hook.result.current.markDirty(STALE));
            await act(async () => {
                answer({ ...DOC, versionId: 'v3', merge: { merged: true, fromOthers: ['b'], othersOutsideSections: false } });
                await saving;
            });
            expect(api.updateDocument).toHaveBeenCalledTimes(2);
            expect(api.updateDocument.mock.calls[1][1]).toEqual({ bodyHtml: STALE, expectedVersionId: 'v1', merge: true });
        });

        it('with nothing typed meanwhile, the base moves on without asking the frame', async () => {
            const reread = vi.fn(async () => undefined);
            const { hook, answer } = mergedWhileTyping(reread);
            act(() => hook.result.current.markDirty('<p>one</p>'));
            let saving!: Promise<void>;
            await act(async () => { saving = hook.result.current.flush(); });
            await act(async () => {
                answer({ ...DOC, versionId: 'v3', merge: { merged: true, fromOthers: ['b'], othersOutsideSections: false } });
                await saving;
            });
            act(() => hook.result.current.markDirty('<p>two</p>'));
            await act(async () => { await hook.result.current.flush(); });
            expect(reread).not.toHaveBeenCalled();
            expect(api.updateDocument.mock.calls[1][1].expectedVersionId).toBe('v3');
        });
    });

    it('a conflict opens "compare and choose", and the choice is saved on the newest revision; later saves use it too', async () => {
        const parts = [{ kind: 'conflict', key: 'pricing/0', label: 'Pricing', base: '<p>b</p>', mine: '<p>mine</p>', theirs: '<p>theirs</p>' }];
        api.updateDocument
            .mockRejectedValueOnce(conflictError({ conflict: { currentVersionId: 'v7', parts } }))
            .mockResolvedValueOnce({ ...DOC, bodyHtml: '<p>theirs</p>', versionId: 'v8' })
            .mockResolvedValueOnce({ ...DOC, bodyHtml: '<p>theirs!</p>', versionId: 'v9' });
        const { hook } = setup();
        act(() => hook.result.current.markDirty('<p>mine</p>'));
        await act(async () => { await hook.result.current.flush().catch(() => undefined); });
        expect(hook.result.current.saveState).toBe('conflict');
        expect(hook.result.current.conflict?.parts[0]).toEqual(expect.objectContaining({ label: 'Pricing' }));
        expect(readDraft('d1')?.html).toBe('<p>mine</p>');

        await act(async () => { await hook.result.current.resolveConflict({ 'pricing/0': 'theirs' }); });
        expect(api.updateDocument.mock.calls[1][1]).toEqual({ bodyHtml: '<p>theirs</p>', expectedVersionId: 'v7', merge: true });
        expect(hook.result.current.conflict).toBeNull();
        expect(hook.result.current.saveState).toBe('saved');

        act(() => hook.result.current.markDirty('<p>theirs!</p>'));
        await act(async () => { await hook.result.current.flush(); });
        expect(api.updateDocument.mock.calls[2][1].expectedVersionId).toBe('v8');
    });

    it('a conflict without parts compares the whole document with the newest one', async () => {
        api.updateDocument.mockRejectedValueOnce(conflictError());
        api.getDocument.mockResolvedValue({ ...DOC, bodyHtml: '<p>server</p>', versionId: 'v5' });
        const { hook } = setup();
        act(() => hook.result.current.markDirty('<p>mine</p>'));
        await act(async () => { await hook.result.current.flush().catch(() => undefined); });
        expect(hook.result.current.conflict).toEqual({ currentVersionId: 'v5', mine: '<p>mine</p>', parts: [{ kind: 'conflict', key: 'all', label: 'Offer', base: '', mine: '<p>mine</p>', theirs: '<p>server</p>' }] });
    });

    it('a failed save keeps the text and the draft, and a retry saves it', async () => {
        api.updateDocument.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 503 })).mockResolvedValueOnce({ ...DOC, versionId: 'v2' });
        const { hook } = setup();
        act(() => hook.result.current.markDirty('<p>keep me</p>'));
        await act(async () => { await hook.result.current.flush().catch(() => undefined); });
        expect(hook.result.current.saveState).toBe('error');
        expect(readDraft('d1')).toEqual(expect.objectContaining({ html: '<p>keep me</p>', base: 'v1' }));
        await act(async () => { await hook.result.current.flush(); });
        expect(api.updateDocument.mock.calls[1][1].bodyHtml).toBe('<p>keep me</p>');
        expect(hook.result.current.saveState).toBe('saved');
    });

    it('a read-only refusal is reported so the editor stops offering edits', async () => {
        api.updateDocument.mockRejectedValueOnce(Object.assign(new Error('read only'), { status: 403, code: 'document_read_only' }));
        const { hook, onReadOnly } = setup();
        act(() => hook.result.current.markDirty('<p>x</p>'));
        await act(async () => { await hook.result.current.flush().catch(() => undefined); });
        expect(onReadOnly).toHaveBeenCalled();
    });

    it('a page that went live meanwhile: the text the server kept is not saved again, and the page is told to join', async () => {
        const live = Object.assign(new Error('This page is being edited live.'), { status: 409, code: 'document_live', conflictVersionId: 'kept-1' });
        api.updateDocument.mockRejectedValueOnce(live);
        const onLive = vi.fn(() => true);
        const docRef = { current: { ...DOC } };
        const hook = renderHook(() => useDocumentAutosave({ documentId: 'd1', docRef, onSaved: vi.fn(), onMerged: vi.fn(async () => true), onReadOnly: vi.fn(), onLive }));
        act(() => hook.result.current.markDirty('<p>typed before it went live</p>'));
        await act(async () => { await hook.result.current.flush().catch(() => undefined); });
        expect(onLive).toHaveBeenCalledWith(live);
        expect(hook.result.current.saveState).toBe('idle');
        expect(hook.result.current.error).toBeNull();
        expect(hook.result.current.hasPending()).toBe(false);
        expect(readDraft('d1')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10); });
        expect(api.updateDocument).toHaveBeenCalledTimes(1);
    });

    it('a page that went live whose text the server could not keep: the draft and the error stay', async () => {
        api.updateDocument.mockRejectedValueOnce(Object.assign(new Error('This page is being edited live.'), { status: 409, code: 'document_live', conflictVersionId: null }));
        const onLive = vi.fn(() => false);
        const docRef = { current: { ...DOC } };
        const hook = renderHook(() => useDocumentAutosave({ documentId: 'd1', docRef, onSaved: vi.fn(), onMerged: vi.fn(async () => true), onReadOnly: vi.fn(), onLive }));
        act(() => hook.result.current.markDirty('<p>only here</p>'));
        await act(async () => { await hook.result.current.flush().catch(() => undefined); });
        expect(onLive).toHaveBeenCalled();
        expect(hook.result.current.saveState).toBe('error');
        expect(readDraft('d1')).toEqual(expect.objectContaining({ html: '<p>only here</p>' }));
    });

    it('a restore replaces what was typed: nothing pending is saved over it', async () => {
        const { hook, docRef } = setup();
        act(() => hook.result.current.markDirty('<p>typed before the restore</p>'));
        act(() => hook.result.current.replaceWith({ ...DOC, bodyHtml: '<p>restored</p>', versionId: 'v6' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10); });
        expect(api.updateDocument).not.toHaveBeenCalled();
        expect(docRef.current.versionId).toBe('v6');
        expect(readDraft('d1')).toBeNull();
    });

    it('a kept draft goes back in as a late save, merged against where it started', async () => {
        api.updateDocument.mockResolvedValue({ ...DOC, versionId: 'v9' });
        const { hook } = setup();
        await act(async () => { await hook.result.current.restoreDraft({ html: '<p>from yesterday</p>', base: 'v0', at: 1 }); });
        expect(api.updateDocument).toHaveBeenCalledWith('d1', { bodyHtml: '<p>from yesterday</p>', expectedVersionId: 'v0', merge: true });
    });
});
