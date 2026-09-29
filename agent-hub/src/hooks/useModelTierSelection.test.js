import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('../utils/helpers', () => ({
    API_BASE: '/api',
    authFetch: (...args) => authFetch(...args),
}));

import useModelTierSelection from './useModelTierSelection';
import { queryClient } from '../api/queryClient';
import { queryWrapper } from '../test/queryWrapper';
import scopedStorage from '../utils/scopedStorage';

// The app's own client: the invalidator acts on that singleton, and
// clearing it before each case keeps one case's answer out of the next.
const wrapper = queryWrapper(queryClient);

const tiersResponse = (tiers) => Promise.resolve({ ok: true, json: () => Promise.resolve(tiers) });

describe('useModelTierSelection', () => {
    beforeEach(() => {
        queryClient.clear();
        scopedStorage.setCurrentUser('test-user');
        scopedStorage.removeItem('testTier');
        authFetch.mockReset();
        authFetch.mockReturnValue(tiersResponse({ auto: {}, fast: {} }));
    });

    it('defaults to auto, fetches the task-aware tier list, and persists changes', async () => {
        const { result } = renderHook(() => useModelTierSelection({ storageKey: 'testTier' }), { wrapper });
        expect(result.current.selectedTier).toBe('auto');
        // The URL is the contract; the second argument carries React Query's
        // AbortSignal, so an unmounted composer does not keep the read alive.
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/ai/config/tiers-for-user?taskType=direct_chat', expect.objectContaining({ signal: expect.any(AbortSignal) })));
        await waitFor(() => expect(Object.keys(result.current.modelTiers)).toContain('fast'));

        act(() => result.current.setSelectedTier('fast'));
        expect(result.current.selectedTier).toBe('fast');
        expect(scopedStorage.getItem('testTier')).toBe('fast');
    });

    it('initializes from the persisted tier', () => {
        scopedStorage.setItem('testTier', 'thinking');
        authFetch.mockReturnValue(new Promise(() => {})); // never resolves — pin the init value
        const { result } = renderHook(() => useModelTierSelection({ storageKey: 'testTier' }), { wrapper });
        expect(result.current.selectedTier).toBe('thinking');
    });

    it('snaps a stale persisted tier back to auto once the list arrives', async () => {
        scopedStorage.setItem('testTier', 'deleted-custom-tier');
        const { result } = renderHook(() => useModelTierSelection({ storageKey: 'testTier' }), { wrapper });
        await waitFor(() => expect(result.current.selectedTier).toBe('auto'));
        expect(scopedStorage.getItem('testTier')).toBe('auto');
    });

    it('passes a custom taskType through to the endpoint', async () => {
        renderHook(() => useModelTierSelection({ storageKey: 'testTier', taskType: 'app_builder' }), { wrapper });
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/api/ai/config/tiers-for-user?taskType=app_builder', expect.anything()));
    });
});
