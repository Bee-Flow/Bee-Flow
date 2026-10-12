import { renderHook, act, render } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./notebookApi', () => ({ notebookApi: vi.fn() }));

import useDocumentAutosave from './useDocumentAutosave';
import { notebookApi } from './notebookApi';

const api = notebookApi as unknown as ReturnType<typeof vi.fn>;
type Call = [string, { method?: string; body?: string } | undefined];
const putCalls = (path?: string) => (api.mock.calls as Call[]).filter(
    ([p, o]) => o?.method === 'PUT' && (path === undefined || p === path),
);
const body = (call: Call) => JSON.parse(call[1]?.body || '{}');
const httpError = (status: number, bodyValue: unknown) => Object.assign(new Error(`HTTP ${status}`), { status, body: bodyValue });

/** A server that enforces compare-and-set on PUT, answering after `ms`. */
function casServer(start: number, ms = 20) {
    let version = start;
    return (_path: string, opts: { method?: string; body?: string } = {}) => new Promise((resolve, reject) => {
        if (opts.method !== 'PUT') { resolve({}); return; }
        const sent = JSON.parse(opts.body || '{}');
        setTimeout(() => {
            if (sent.expectedVersion != null && sent.expectedVersion !== version) {
                reject(httpError(409, { code: 'version_conflict', details: { conflictVersionId: 'vx', currentVersion: version } }));
                return;
            }
            version += 1;
            resolve({ success: true, version });
        }, ms);
    });
}

/** The editor as the page mounts it: a child whose flush() is exposed through its ref, with a debounced save pending. */
const EditorWithPendingSave = forwardRef(function EditorWithPendingSave({ onSave }: { onSave: (html: string) => void }, ref) {
    useImperativeHandle(ref, () => ({ flush: () => { onSave('<p>typed a second ago</p>'); return '<p>typed a second ago</p>'; } }));
    return null;
});

function PageWithEditor() {
    const autosave = useDocumentAutosave({ entityId: 'nb1', initialVersion: 3 });
    return <EditorWithPendingSave ref={autosave.editorRef as never} onSave={autosave.handleDocSave} />;
}

describe('useDocumentAutosave', () => {
    beforeEach(() => { api.mockReset(); });
    afterEach(() => vi.useRealTimers());

    it('sends expectedVersion from the seeded counter and adopts the returned version', async () => {
        api.mockResolvedValue({ success: true, version: 4 });
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3 }));
        await act(async () => { await result.current.handleDocSave('<p>a</p>'); });
        expect(body(putCalls('/nb1')[0])).toEqual({ documentContent: '<p>a</p>', expectedVersion: 3 });

        api.mockResolvedValue({ success: true, version: 5 });
        await act(async () => { await result.current.handleDocSave('<p>b</p>'); });
        expect(body(putCalls('/nb1')[1]).expectedVersion).toBe(4);
    });

    it('omits expectedVersion when no version is known, then self-seeds from the response', async () => {
        api.mockResolvedValue({ success: true, version: 2 });
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1' }));
        await act(async () => { await result.current.handleDocSave('<p>a</p>'); });
        expect(body(putCalls('/nb1')[0])).toEqual({ documentContent: '<p>a</p>' });

        await act(async () => { await result.current.handleDocSave('<p>b</p>'); });
        expect(body(putCalls('/nb1')[1]).expectedVersion).toBe(2);
    });

    it('setKnownVersion resyncs the counter (AI edit and restore path)', async () => {
        api.mockResolvedValue({ success: true, version: 11 });
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3 }));
        act(() => result.current.setKnownVersion(10));
        await act(async () => { await result.current.handleDocSave('<p>a</p>'); });
        expect(body(putCalls('/nb1')[0]).expectedVersion).toBe(10);
    });

    it('on a 409 it keeps the local text, reports the kept version, pauses saving and reloads nothing', async () => {
        vi.useFakeTimers();
        const onConflict = vi.fn();
        api.mockImplementation((_path: string, opts: { method?: string } = {}) => (opts.method === 'PUT'
            ? Promise.reject(httpError(409, { code: 'version_conflict', details: { conflictVersionId: 'v9', currentVersion: 7 } }))
            : Promise.resolve({})));
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3, onConflict }));
        const setContent = vi.fn();
        result.current.editorRef.current = { setContent };

        await act(async () => { await result.current.handleDocSave('<p>mine</p>'); });
        expect(onConflict).toHaveBeenCalledWith({ notebookId: 'nb1', localHtml: '<p>mine</p>', conflictVersionId: 'v9', currentVersion: 7 });
        expect(setContent).not.toHaveBeenCalled();
        expect(result.current.saveState).toBe('conflict');
        expect((api.mock.calls as Call[]).filter(([, o]) => !o?.method)).toHaveLength(0);

        // Typing on while the choice is open queues, but sends nothing.
        await act(async () => { await result.current.handleDocSave('<p>mine, and more</p>'); });
        await act(async () => { vi.advanceTimersByTime(10000); });
        expect(putCalls()).toHaveLength(1);
        expect(result.current.pendingContentRef.current).toBe('<p>mine, and more</p>');
    });

    it('keeping my text after a conflict saves it over the version the user compared against', async () => {
        api.mockRejectedValueOnce(httpError(409, { code: 'version_conflict', details: { conflictVersionId: 'v9', currentVersion: 7 } }));
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3, onConflict: vi.fn() }));
        await act(async () => { await result.current.handleDocSave('<p>mine</p>'); });

        api.mockResolvedValue({ success: true, version: 8 });
        await act(async () => { await result.current.resolveConflict({ keepServer: false, version: 7, html: '<p>mine, final</p>' }); });
        expect(body(putCalls().at(-1) as Call)).toEqual({ documentContent: '<p>mine, final</p>', expectedVersion: 7 });
        expect(result.current.saveState).toBe('idle');
    });

    it('keeping theirs drops the pending text and resumes from their version', async () => {
        api.mockRejectedValueOnce(httpError(409, { code: 'version_conflict', details: { conflictVersionId: 'v9', currentVersion: 7 } }));
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3, onConflict: vi.fn() }));
        await act(async () => { await result.current.handleDocSave('<p>mine</p>'); });
        await act(async () => { await result.current.resolveConflict({ keepServer: true, version: 7 }); });
        expect(result.current.pendingContentRef.current).toBe(null);
        expect(result.current.dirty).toBe(false);

        api.mockResolvedValue({ success: true, version: 8 });
        await act(async () => { await result.current.handleDocSave('<p>next</p>'); });
        expect(body(putCalls().at(-1) as Call).expectedVersion).toBe(7);
    });

    it('a live co-editing session that started meanwhile hands over instead of failing', async () => {
        const onCollabActive = vi.fn();
        api.mockImplementation(() => Promise.reject(httpError(409, { code: 'COLLAB_ACTIVE' })));
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3, onCollabActive }));
        await act(async () => { await result.current.handleDocSave('<p>mine</p>'); });
        expect(onCollabActive).toHaveBeenCalledWith(null);
        expect(result.current.hasUnsaved()).toBe(false);
        expect(result.current.saveState).toBe('idle');
    });

    it('while bound to a live session (or read-only) it never PUTs, not even on leave or Ctrl+S', async () => {
        api.mockResolvedValue({ success: true, version: 4 });
        const { result, rerender } = renderHook(
            ({ entityId, bound, readOnly }: { entityId: string; bound: boolean; readOnly: boolean }) => useDocumentAutosave({ entityId, initialVersion: 3, bound, readOnly }),
            { initialProps: { entityId: 'a', bound: true, readOnly: false } },
        );
        const flush = vi.fn(() => '<p>typed</p>');
        result.current.editorRef.current = { flush, getEditor: () => ({ getHTML: () => '<p>x</p>' }) };
        await act(async () => { await result.current.handleDocSave('<p>typed</p>'); });
        act(() => { result.current.markDirty(); });
        expect(result.current.dirty).toBe(false);
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true })); });
        await act(async () => { rerender({ entityId: 'b', bound: false, readOnly: true }); });
        await act(async () => { await result.current.handleDocSave('<p>viewer typed</p>'); });
        expect(putCalls()).toHaveLength(0);
        expect(flush).not.toHaveBeenCalled();
    });

    it('entity-switch cleanup does not re-PUT content that flush() already saved', async () => {
        api.mockResolvedValue({ success: true, version: 1 });
        const { result, rerender } = renderHook(
            ({ entityId }: { entityId: string }) => useDocumentAutosave({ entityId }),
            { initialProps: { entityId: 'a' } },
        );
        const flush = vi.fn(() => '<p>flushed</p>');
        result.current.editorRef.current = { flush };
        result.current.pendingContentRef.current = '<p>stale-pending</p>';

        await act(async () => { rerender({ entityId: 'b' }); });
        expect(flush).toHaveBeenCalledTimes(1);
        expect(putCalls('/a')).toHaveLength(0);
    });

    it('entity-switch cleanup PUTs remaining pending content WITH the version it was based on', async () => {
        api.mockResolvedValue({ success: true, version: 9 });
        const { result, rerender } = renderHook(
            ({ entityId }: { entityId: string }) => useDocumentAutosave({ entityId, initialVersion: 5 }),
            { initialProps: { entityId: 'a' } },
        );
        result.current.editorRef.current = { flush: () => null };
        result.current.pendingContentRef.current = '<p>pending</p>';

        await act(async () => { rerender({ entityId: 'b' }); });
        const calls = putCalls('/a');
        expect(calls).toHaveLength(1);
        expect(body(calls[0])).toEqual({ documentContent: '<p>pending</p>', expectedVersion: 5 });
    });

    it('a flush-triggered save during entity switch is a compare-and-set write and is not doubled', async () => {
        api.mockResolvedValue({ success: true, version: 9 });
        const { result, rerender } = renderHook(
            ({ entityId }: { entityId: string }) => useDocumentAutosave({ entityId, initialVersion: 5 }),
            { initialProps: { entityId: 'a' } },
        );
        const saveForA = result.current.handleDocSave;
        result.current.editorRef.current = {
            flush: () => { void saveForA('<p>typed</p>'); return '<p>typed</p>'; },
        };

        await act(async () => { rerender({ entityId: 'b' }); });
        const calls = putCalls('/a');
        expect(calls).toHaveLength(1);
        expect(body(calls[0])).toEqual({ documentContent: '<p>typed</p>', expectedVersion: 5 });
    });

    it('leaving the notebook (the page unmounts) flushes the editor\'s pending save while its handle is still attached', async () => {
        api.mockResolvedValue({ success: true, version: 4 });
        const view = render(<PageWithEditor />);
        await act(async () => { view.unmount(); });
        // The flush used to run in a passive cleanup, after React had already
        // detached the editor's handle: no PUT, the last seconds of typing lost.
        const calls = putCalls('/nb1');
        expect(calls).toHaveLength(1);
        expect(body(calls[0])).toEqual({ documentContent: '<p>typed a second ago</p>', expectedVersion: 3 });
    });

    it('overlapping saves go one at a time, each over the version the previous one produced', async () => {
        const onConflict = vi.fn();
        api.mockImplementation(casServer(3));
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3, onConflict }));
        await act(async () => {
            // The debounced save, then Ctrl+S / a flush while it is still in flight.
            const first = result.current.handleDocSave('<p>a</p>');
            const second = result.current.handleDocSave('<p>ab</p>');
            await Promise.all([first, second]);
        });
        expect(putCalls().map((c) => body(c))).toEqual([
            { documentContent: '<p>a</p>', expectedVersion: 3 },
            { documentContent: '<p>ab</p>', expectedVersion: 4 },
        ]);
        expect(onConflict).not.toHaveBeenCalled();
        expect(result.current.saveState).toBe('idle');
        expect(result.current.hasUnsaved()).toBe(false);
    });

    it('a held Ctrl+S saves once', async () => {
        api.mockImplementation(casServer(3));
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3 }));
        result.current.editorRef.current = { getEditor: () => ({ getHTML: () => '<p>x</p>' }) };
        await act(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, repeat: true }));
            await new Promise((r) => setTimeout(r, 60));
        });
        expect(putCalls()).toHaveLength(1);
    });

    it('after COLLAB_ACTIVE saving waits for the live session instead of piling up refused saves', async () => {
        const onCollabActive = vi.fn();
        api.mockImplementation((path: string, opts: { method?: string } = {}) => (opts.method === 'PUT'
            ? Promise.reject(httpError(409, { code: 'COLLAB_ACTIVE', details: { conflictVersionId: 'v7' } }))
            : Promise.resolve({ version: { id: 'v8' } })));
        const { result, rerender } = renderHook(
            ({ bound }: { bound: boolean }) => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3, onCollabActive, bound }),
            { initialProps: { bound: false } },
        );
        await act(async () => { await result.current.handleDocSave('<p>one</p>'); });
        expect(onCollabActive).toHaveBeenCalledWith('v7');

        // The join has not answered (or failed): typing on is kept, not sent.
        act(() => { result.current.markDirty(); });
        await act(async () => { await result.current.handleDocSave('<p>one two</p>'); });
        await act(async () => { await result.current.handleDocSave('<p>one two three</p>'); });
        expect(putCalls()).toHaveLength(1);
        expect(result.current.hasUnsaved()).toBe(true);

        // The session takes over: what was typed while waiting is kept as a version first.
        await act(async () => { rerender({ bound: true }); });
        const kept = (api.mock.calls as Call[]).filter(([p, o]) => p === '/nb1/versions/kept' && o?.method === 'POST');
        expect(kept.map((c) => body(c))).toEqual([{ html: '<p>one two three</p>' }]);
        act(() => { result.current.resumeSaving(); });
        expect(putCalls()).toHaveLength(1);
    });

    it('when the page cannot join the live session, saving goes on: each refused text is kept, and saves land once the session is over', async () => {
        let collabActive = true;
        api.mockImplementation((_path: string, opts: { method?: string } = {}) => {
            if (opts.method !== 'PUT') return Promise.resolve({});
            return collabActive
                ? Promise.reject(httpError(409, { code: 'COLLAB_ACTIVE', details: { conflictVersionId: 'v7' } }))
                : Promise.resolve({ success: true, version: 4 });
        });
        // The owner outside the project: nobody will ever call resumeSaving.
        const onCollabActive = vi.fn(() => false);
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3, onCollabActive }));
        await act(async () => { await result.current.handleDocSave('<p>one</p>'); });
        // Typed while that refused save was in flight: it goes right after, not left pending.
        await act(async () => {
            const first = result.current.handleDocSave('<p>one two</p>');
            const second = result.current.handleDocSave('<p>one two three</p>');
            await Promise.all([first, second]);
        });
        expect(putCalls().map((c) => body(c).documentContent)).toEqual(['<p>one</p>', '<p>one two</p>', '<p>one two three</p>']);
        expect(onCollabActive).toHaveBeenCalledTimes(3);
        expect(result.current.hasUnsaved()).toBe(false);

        // The live session is over: the next save lands.
        collabActive = false;
        await act(async () => { await result.current.handleDocSave('<p>one two three four</p>'); });
        expect(putCalls()).toHaveLength(4);
        expect(result.current.saveState).toBe('idle');
        expect(result.current.hasUnsaved()).toBe(false);
    });

    it('when the notebook is not co-edited after all, saving resumes with what was typed meanwhile', async () => {
        let collabActive = true;
        api.mockImplementation((_path: string, opts: { method?: string } = {}) => {
            if (opts.method !== 'PUT') return Promise.resolve({});
            return collabActive ? Promise.reject(httpError(409, { code: 'COLLAB_ACTIVE' })) : Promise.resolve({ success: true, version: 4 });
        });
        const { result } = renderHook(() => useDocumentAutosave({ entityId: 'nb1', initialVersion: 3, onCollabActive: vi.fn() }));
        await act(async () => { await result.current.handleDocSave('<p>one</p>'); });
        await act(async () => { await result.current.handleDocSave('<p>one two</p>'); });
        collabActive = false;
        await act(async () => { result.current.resumeSaving(); await new Promise((r) => setTimeout(r, 0)); });
        expect(putCalls().map((c) => body(c).documentContent)).toEqual(['<p>one</p>', '<p>one two</p>']);
        expect(result.current.hasUnsaved()).toBe(false);
    });
});
