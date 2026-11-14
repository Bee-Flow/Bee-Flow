import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavigateToPage } from './useNavigateToPage';

function navigation() {
    const { result } = renderHook(() => useNavigateToPage({ isMobile: false, isConsumerAccount: false }));
    return { navigate: (page: string, options?: { replace?: boolean }) => act(() => result.current(page, options)) };
}

beforeEach(() => window.history.replaceState({}, '', '/app/studio/documents'));

describe('document navigation in the member workspace', () => {
    it('opens the member library at its own address, with the page in the history state', () => {
        const { navigate } = navigation();
        navigate('documents');
        expect(window.location.pathname).toBe('/app/documents');
        expect(window.history.state).toEqual({ page: 'documents' });
    });

    it('updates the selected item on the same page and returns to its library', () => {
        const { navigate } = navigation();
        navigate('documents/d1');
        expect(window.location.pathname).toBe('/app/documents/d1');
        navigate('documents/notebook/n1');
        expect(window.location.pathname).toBe('/app/documents/notebook/n1');
        navigate('documents');
        expect(window.location.pathname).toBe('/app/documents');
    });

    it('honours replacement navigation without adding history entries', () => {
        const { navigate } = navigation();
        const push = vi.spyOn(window.history, 'pushState');
        const replace = vi.spyOn(window.history, 'replaceState');
        navigate('documents/d1', { replace: true });
        expect(push).not.toHaveBeenCalled();
        expect(replace).toHaveBeenCalledWith({ page: 'documents' }, '', '/app/documents/d1');
        push.mockRestore();
        replace.mockRestore();
    });
});
