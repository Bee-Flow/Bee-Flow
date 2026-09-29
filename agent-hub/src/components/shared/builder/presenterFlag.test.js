import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPresenter, subscribePresenter, writePresenter } from './presenterFlag';
import { setCurrentUser } from '../../../utils/scopedStorage';
import usePresenterFlag from '../../admin/Studio/Playbooks/usePresenterFlag';

/**
 * The Playbook bar mirrors the builders' Shift+P without binding the key
 * itself: writePresenter notifies, subscribePresenter hears it, the hook
 * re-renders. One storage key for every film.
 */
describe('presenterFlag — one flag, every film', () => {
    beforeEach(() => { setCurrentUser('u1'); writePresenter(false); });
    afterEach(() => { writePresenter(false); });

    it('writePresenter notifies subscribers, and the unsubscribe stops them', () => {
        const cb = vi.fn();
        const off = subscribePresenter(cb);
        writePresenter(true);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(cb.mock.calls[0][0].detail).toBe(true);
        expect(readPresenter()).toBe(true);
        off();
        writePresenter(false);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('usePresenterFlag follows the builders\' toggle live', () => {
        const { result } = renderHook(() => usePresenterFlag());
        expect(result.current).toBe(false);
        act(() => writePresenter(true));
        expect(result.current).toBe(true);
        act(() => writePresenter(false));
        expect(result.current).toBe(false);
    });
});
