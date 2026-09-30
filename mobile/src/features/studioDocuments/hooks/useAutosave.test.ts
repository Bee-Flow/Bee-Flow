import { act, renderHook } from '@testing-library/react-native';

import { useAutosave } from './useAutosave';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('useAutosave', () => {
    it('saves the newest body once typing pauses', async () => {
        const save = jest.fn(async () => undefined);
        const { result } = await renderHook(() => useAutosave(save, 1000));
        await act(async () => {
            result.current.schedule('a');
            result.current.schedule('ab');
        });
        expect(result.current.state).toBe('saving');
        expect(save).not.toHaveBeenCalled();
        await act(async () => {
            jest.advanceTimersByTime(1000);
        });
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith('ab');
        expect(result.current.state).toBe('saved');
    });

    it('keeps a failed body for the retry and reports the error', async () => {
        const save = jest.fn().mockRejectedValueOnce(new Error('conflict')).mockResolvedValueOnce(undefined);
        const { result } = await renderHook(() => useAutosave(save, 1000));
        await act(async () => {
            result.current.schedule('x');
            await result.current.flush().catch(() => undefined);
        });
        expect(result.current.state).toBe('error');
        expect((result.current.error as Error).message).toBe('conflict');
        await act(async () => {
            await result.current.flush();
        });
        expect(save).toHaveBeenLastCalledWith('x');
        expect(result.current.state).toBe('saved');
    });

    it('saves what is pending when the screen goes away', async () => {
        const save = jest.fn(async () => undefined);
        const { result, unmount } = await renderHook(() => useAutosave(save, 1000));
        await act(async () => result.current.schedule('last words'));
        await act(async () => unmount());
        expect(save).toHaveBeenCalledWith('last words');
    });

    it('does nothing when nothing is pending', async () => {
        const save = jest.fn(async () => undefined);
        const { result } = await renderHook(() => useAutosave(save));
        await act(async () => {
            await result.current.flush();
        });
        expect(save).not.toHaveBeenCalled();
        expect(result.current.state).toBe('idle');
    });

    it('discards a failed body so neither retry nor leaving writes it', async () => {
        const save = jest.fn().mockRejectedValueOnce(new Error('conflict'));
        const { result, unmount } = await renderHook(() => useAutosave(save, 1000));
        await act(async () => {
            result.current.schedule('thrown away');
            await result.current.flush().catch(() => undefined);
        });
        expect(result.current.state).toBe('error');
        await act(async () => result.current.discard());
        expect(result.current.state).toBe('idle');
        expect(result.current.error).toBeNull();
        await act(async () => {
            await result.current.flush();
        });
        await act(async () => unmount());
        expect(save).toHaveBeenCalledTimes(1);
    });
});
