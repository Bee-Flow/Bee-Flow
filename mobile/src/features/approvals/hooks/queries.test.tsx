/**
 * An open inbox and the drawer's badge re-read the approvals every 30 s, as
 * the web does, so one that arrives meanwhile shows up without a pull; the
 * other readers (the Cowork hub's pointer) do not poll.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { useApprovals } from './queries';
import { listApprovals } from '../api/endpoints';

jest.mock('../api/endpoints', () => ({ listApprovals: jest.fn(async () => []) }));

const list = listApprovals as jest.MockedFunction<typeof listApprovals>;

async function mount(poll: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = await renderHook(() => useApprovals('pending', { staleTime: 30_000, poll }), { wrapper });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    return hook;
}

beforeEach(() => {
    jest.useFakeTimers();
    list.mockClear();
});

afterEach(() => jest.useRealTimers());

describe('useApprovals', () => {
    it('re-reads the list every 30 seconds while it is watched', async () => {
        const { unmount } = await mount(true);
        expect(list).toHaveBeenCalledTimes(1);
        await act(async () => {
            jest.advanceTimersByTime(30_000);
        });
        await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
        await unmount();
    });

    it('does not poll for a reader that only points at the inbox', async () => {
        const { unmount } = await mount(false);
        await act(async () => {
            jest.advanceTimersByTime(90_000);
        });
        expect(list).toHaveBeenCalledTimes(1);
        await unmount();
    });
});
