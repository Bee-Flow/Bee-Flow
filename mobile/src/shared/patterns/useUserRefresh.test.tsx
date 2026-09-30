/**
 * The pull-to-refresh flag follows the person's pull, not the query: it rises
 * when the pull starts, falls when that pull's promise settles (resolved,
 * rejected or thrown), and a background refetch never raises it.
 */

import { act, renderHook } from '@testing-library/react-native';

import { useUserRefresh } from './useUserRefresh';

function deferred() {
    let resolve: () => void = () => undefined;
    let reject: (err: unknown) => void = () => undefined;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('useUserRefresh', () => {
    it('is quiet until the person pulls', async () => {
        const { result } = await renderHook(() => useUserRefresh(jest.fn()));
        expect(result.current.refreshing).toBe(false);
    });

    it('spins from the pull until the refresh settles', async () => {
        const pending = deferred();
        const refresh = jest.fn(() => pending.promise);
        const { result } = await renderHook(() => useUserRefresh(refresh));
        await act(async () => result.current.onRefresh());
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(result.current.refreshing).toBe(true);
        await act(async () => pending.resolve());
        expect(result.current.refreshing).toBe(false);
    });

    it('stops spinning when the refresh fails', async () => {
        const pending = deferred();
        const { result } = await renderHook(() => useUserRefresh(() => pending.promise));
        await act(async () => result.current.onRefresh());
        expect(result.current.refreshing).toBe(true);
        await act(async () => pending.reject(new Error('offline')));
        expect(result.current.refreshing).toBe(false);
    });

    it('stops spinning when the refresh throws before it returns', async () => {
        const { result } = await renderHook(() =>
            useUserRefresh(() => {
                throw new Error('boom');
            }),
        );
        await act(async () => result.current.onRefresh());
        expect(result.current.refreshing).toBe(false);
    });

    it('calls the refresh at once, so a pull reaches it without waiting a tick', async () => {
        const refresh = jest.fn();
        const { result } = await renderHook(() => useUserRefresh(refresh));
        let calledInline = 0;
        await act(async () => {
            result.current.onRefresh();
            calledInline = refresh.mock.calls.length;
        });
        expect(calledInline).toBe(1);
    });

    it('waits for every query of a screen made of several', async () => {
        const first = deferred();
        const second = deferred();
        const { result } = await renderHook(() => useUserRefresh(() => Promise.all([first.promise, second.promise])));
        await act(async () => result.current.onRefresh());
        await act(async () => first.resolve());
        expect(result.current.refreshing).toBe(true);
        await act(async () => second.resolve());
        expect(result.current.refreshing).toBe(false);
    });
});
