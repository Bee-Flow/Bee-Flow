import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import useTranscription from './useTranscription';

const getTranscription = vi.fn();
vi.mock('../../../api/transcriptionsApi', () => ({ getTranscription: (id: string) => getTranscription(id) }));

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
});
