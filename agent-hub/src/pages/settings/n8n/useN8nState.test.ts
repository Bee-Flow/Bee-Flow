// The n8n status line. Pinned: every message gets its own time; the clear that
// an earlier message scheduled must not take a later one down early.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlashMessage } from './useN8nState';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useFlashMessage', () => {
    it('keeps a later message until its own clear', () => {
        const { result } = renderHook(() => useFlashMessage());
        act(() => { result.current.setMessage({ type: 'success', text: 'Found 3 webhook workflow(s)' }); result.current.clearAfter(4000); });
        act(() => { vi.advanceTimersByTime(3500); });
        act(() => { result.current.setMessage({ type: 'success', text: 'Added "Invoices"' }); result.current.clearAfter(2000); });
        // The first message's four seconds are over; the second one is 600 ms old.
        act(() => { vi.advanceTimersByTime(600); });
        expect(result.current.message?.text).toBe('Added "Invoices"');
        act(() => { vi.advanceTimersByTime(1500); });
        expect(result.current.message).toBeNull();
    });
});
