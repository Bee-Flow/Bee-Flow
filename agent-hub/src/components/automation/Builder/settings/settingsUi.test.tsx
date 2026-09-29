import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useQueuedSave, withDefinition } from './settingsUi';

describe('useQueuedSave', () => {
    it('runs saves one at a time and keeps the key an earlier save changed', async () => {
        const base = { trigger: { kind: 'manual' }, runPolicy: { retry: { max: 0 } }, notificationSettings: { a: 1 } };
        let release: () => void = () => undefined;
        const onSave = vi.fn((patch: Record<string, unknown>) => {
            void patch;
            return onSave.mock.calls.length === 1 ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
        });
        const { result } = renderHook(() => useQueuedSave(onSave, base));
        const automation = { definition: base };
        let first: Promise<unknown> = Promise.resolve();
        let second: Promise<unknown> = Promise.resolve();
        act(() => {
            // Both built from the SAME stale row, as two sections would.
            first = result.current(withDefinition(automation, 'runPolicy', { retry: { max: 2 } }));
            second = result.current(withDefinition(automation, 'notificationSettings', { a: 2 }));
        });
        await act(async () => { await Promise.resolve(); });
        expect(onSave).toHaveBeenCalledTimes(1);
        await act(async () => { release(); await first; await second; });
        expect(onSave).toHaveBeenCalledTimes(2);
        expect(onSave.mock.calls[1][0]).toEqual({
            definition: { trigger: { kind: 'manual' }, runPolicy: { retry: { max: 2 } }, notificationSettings: { a: 2 } },
        });
    });

    it('starts from the server row again after a refused save', async () => {
        const base = { runPolicy: {}, notificationSettings: {} };
        const onSave = vi.fn()
            .mockRejectedValueOnce(new Error('Invalid definition'))
            .mockResolvedValue(undefined);
        const { result } = renderHook(() => useQueuedSave(onSave, base));
        await act(async () => {
            await result.current(withDefinition({ definition: base }, 'notificationSettings', { bad: true })).catch(() => undefined);
        });
        await act(async () => { await result.current(withDefinition({ definition: base }, 'runPolicy', { concurrency: 'parallel' })); });
        expect(onSave.mock.calls[1][0]).toEqual({ definition: { runPolicy: { concurrency: 'parallel' }, notificationSettings: {} } });
    });

    it('passes a patch without a definition through untouched', async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() => useQueuedSave(onSave, {}));
        await act(async () => { await result.current({ title: 'New' }); });
        expect(onSave).toHaveBeenCalledWith({ title: 'New' });
    });
});
