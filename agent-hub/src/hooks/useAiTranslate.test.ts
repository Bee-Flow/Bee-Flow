import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useAiTranslate from './useAiTranslate';

describe('useAiTranslate', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('shows a successful result and clears it after clearAfterMs', async () => {
        const request = vi.fn(async () => ({ success: true, message: 'first' }));
        const { result } = renderHook(() => useAiTranslate({ request, clearAfterMs: 8000 }));

        await act(async () => { await result.current.run(); });
        expect(result.current.result?.message).toBe('first');

        act(() => { vi.advanceTimersByTime(8000); });
        expect(result.current.result).toBeNull();
    });

    it('a second run keeps its result for the full time, whatever the first run scheduled', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce({ success: true, message: 'first' })
            .mockResolvedValueOnce({ success: true, message: 'second' });
        const { result } = renderHook(() => useAiTranslate({ request, clearAfterMs: 8000 }));

        await act(async () => { await result.current.run(); });
        act(() => { vi.advanceTimersByTime(5000); });
        await act(async () => { await result.current.run(); });
        expect(result.current.result?.message).toBe('second');

        // 8 s after the FIRST run: the second result is 3 s old and must stay.
        act(() => { vi.advanceTimersByTime(3000); });
        expect(result.current.result?.message).toBe('second');

        act(() => { vi.advanceTimersByTime(5000); });
        expect(result.current.result).toBeNull();
    });
});
