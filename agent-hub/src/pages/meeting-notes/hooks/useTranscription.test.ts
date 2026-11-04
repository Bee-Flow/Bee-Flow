import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import useTranscription from './useTranscription';

const getTranscription = vi.fn();
vi.mock('@/api/transcriptionsApi', () => ({ getTranscription: (id: string) => getTranscription(id) }));

describe('useTranscription setLocal', () => {
    it('does not build a partial note from a function updater before the note has loaded', async () => {
        getTranscription.mockReturnValue(new Promise(() => {}));
        const { result } = renderHook(() => useTranscription('n1'));
        const updater = vi.fn((p: { title?: string }) => ({ ...p, title: 'x' }));
        act(() => { result.current.setLocal(updater as never); });
        expect(updater).not.toHaveBeenCalled();
        expect(result.current.data).toBeNull();
    });

    it('applies a function updater once the note is there', async () => {
        getTranscription.mockResolvedValue({ id: 'n1', title: 'old' });
        const { result } = renderHook(() => useTranscription('n1'));
        await waitFor(() => expect(result.current.data).not.toBeNull());
        act(() => { result.current.setLocal((p) => (p ? { ...p, title: 'new' } : p)); });
        expect(result.current.data?.title).toBe('new');
    });

    it('drops a late write meant for the note the view showed before (switching notes in the library)', async () => {
        getTranscription.mockImplementation(async (id: string) => ({ id, title: `title ${id}`, summary: `summary ${id}` }));
        const { result, rerender } = renderHook(({ id }) => useTranscription(id), { initialProps: { id: 'A' } });
        await waitFor(() => expect(result.current.data?.id).toBe('A'));
        // A regenerate started on A holds A's setLocal while it waits.
        const setLocalOfA = result.current.setLocal;

        rerender({ id: 'B' });
        await waitFor(() => expect(result.current.data?.id).toBe('B'));

        // A's answer arrives after B has loaded.
        act(() => { setLocalOfA((p) => ({ ...p, summary: 'regenerated A' })); });
        act(() => { setLocalOfA(() => ({ id: 'A', title: 'title A' }) as never); });
        expect(result.current.data).toEqual({ id: 'B', title: 'title B', summary: 'summary B' });

        // B's own writes still land.
        act(() => { result.current.setLocal((p) => ({ ...p, title: 'renamed B' })); });
        expect(result.current.data?.title).toBe('renamed B');
    });
});
