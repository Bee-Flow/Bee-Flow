import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import useCloseReviewWhenBuilt from './useCloseReviewWhenBuilt';

describe('useCloseReviewWhenBuilt', () => {
    it('closes the review when the plan turns built, and not before', () => {
        const setOpen = vi.fn();
        const { rerender } = renderHook(({ status }) => useCloseReviewWhenBuilt({ id: 'p', status }, setOpen), { initialProps: { status: 'review' } });
        expect(setOpen).not.toHaveBeenCalled();
        rerender({ status: 'building' });
        expect(setOpen).not.toHaveBeenCalled();
        rerender({ status: 'built' });
        expect(setOpen).toHaveBeenCalledWith(false);
    });
});
