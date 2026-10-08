import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./notebookApi', () => ({
    notebookApi: vi.fn(),
    uploadSourceFile: vi.fn(),
    getSourceContent: vi.fn(),
    renameSource: vi.fn(),
    reorderSourcesApi: vi.fn(),
    bulkDeleteSourcesApi: vi.fn(),
}));

import useSourcesPolling, { UNDO_DELETE_MS } from './useSourcesPolling';
import { notebookApi, uploadSourceFile } from './notebookApi';

const api = notebookApi as unknown as ReturnType<typeof vi.fn>;
const upload = uploadSourceFile as unknown as ReturnType<typeof vi.fn>;
const SOURCES = [
    { id: 's1', name: 'One', type: 'text', status: 'ready' },
    { id: 's2', name: 'Two', type: 'text', status: 'ready' },
];
const deletes = () => api.mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === 'DELETE');
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
    api.mockReset();
    api.mockResolvedValue({ sources: SOURCES });
    upload.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('removing a source', () => {
    it('takes it off the list at once and sends the removal only after the undo window', async () => {
        vi.useFakeTimers();
        const onChanged = vi.fn();
        const { result } = renderHook(() => useSourcesPolling({ entityId: 'nb1', onChanged }));
        act(() => result.current.seedSources(SOURCES));
        act(() => result.current.handleDeleteSource('s1'));
        expect(result.current.sources.map((s) => s.id)).toEqual(['s2']);
        expect(result.current.pendingDelete?.source.id).toBe('s1');
        expect(deletes()).toHaveLength(0);

        await act(async () => { vi.advanceTimersByTime(UNDO_DELETE_MS); });
        await flush();
        expect(deletes()).toHaveLength(1);
        expect(deletes()[0][0]).toBe('/nb1/sources/s1');
        expect(result.current.pendingDelete).toBe(null);
        expect(onChanged).toHaveBeenCalled();
    });

    it('Undo puts it back where it was and nothing is sent', async () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useSourcesPolling({ entityId: 'nb1' }));
        act(() => result.current.seedSources(SOURCES));
        act(() => result.current.handleDeleteSource('s1'));
        act(() => result.current.undoDelete());
        expect(result.current.sources.map((s) => s.id)).toEqual(['s1', 's2']);
        await act(async () => { vi.advanceTimersByTime(UNDO_DELETE_MS * 2); });
        expect(deletes()).toHaveLength(0);
    });

    it('leaving the notebook settles a pending removal right away', async () => {
        const { result, unmount } = renderHook(() => useSourcesPolling({ entityId: 'nb1' }));
        act(() => result.current.seedSources(SOURCES));
        act(() => result.current.handleDeleteSource('s2'));
        unmount();
        await flush();
        expect(deletes().map(([p]) => p)).toEqual(['/nb1/sources/s2']);
    });

    it('a refused removal brings the source back and says why', async () => {
        vi.useFakeTimers();
        const onError = vi.fn();
        api.mockImplementation(async (_p: string, o?: { method?: string }) => {
            if (o?.method === 'DELETE') throw new Error('You can view this notebook but not change it.');
            return { sources: SOURCES };
        });
        const { result } = renderHook(() => useSourcesPolling({ entityId: 'nb1', onError }));
        act(() => result.current.seedSources(SOURCES));
        act(() => result.current.handleDeleteSource('s1'));
        await act(async () => { vi.advanceTimersByTime(UNDO_DELETE_MS); });
        await flush();
        expect(result.current.sources.map((s) => s.id)).toEqual(['s1', 's2']);
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('not change it'));
    });
});

describe('the upload queue', () => {
    it('uploads two at a time, marks each file, and keeps a failed one for a retry', async () => {
        const resolvers: Array<() => void> = [];
        upload.mockImplementation((_id: string, file: File) => new Promise((resolve, reject) => {
            if (file.name === 'bad.pdf') { reject(new Error('This file is too large.')); return; }
            resolvers.push(() => resolve({ source: { id: file.name } }));
        }));
        const { result } = renderHook(() => useSourcesPolling({ entityId: 'nb1' }));
        const files = ['a.pdf', 'b.pdf', 'bad.pdf'].map((n) => new File(['x'], n));
        await act(async () => { result.current.handleFileUpload(files); });
        await flush();
        expect(upload).toHaveBeenCalledTimes(2);
        expect(result.current.uploads.map((u) => u.status)).toEqual(['uploading', 'uploading', 'queued']);

        await act(async () => { resolvers[0](); });
        await flush();
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
        expect(upload).toHaveBeenCalledTimes(3);
        const bad = result.current.uploads.find((u) => u.name === 'bad.pdf');
        expect(bad).toMatchObject({ status: 'failed', error: 'This file is too large.' });
        expect(result.current.uploads.find((u) => u.name === 'a.pdf')?.status).toBe('done');

        upload.mockImplementation(async () => ({ source: { id: 'ok' } }));
        await act(async () => { result.current.retryUpload(bad!.id); });
        await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
        expect(result.current.uploads.find((u) => u.name === 'bad.pdf')?.status).toBe('done');
    });
});
