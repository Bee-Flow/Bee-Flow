/**
 * The routines list is re-read when a run ends, and only then: a start or a
 * step leaves it alone, and the list screen and the detail screen above it
 * hearing the same end cost one read, not two.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { useSettledRunRefresh } from './mutations';
import { automationKeys } from '../api/keys';

function setup() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const readList = jest.fn(async () => []);
    return { queryClient, wrapper, readList };
}

/** The list, observed the way AutomationsScreen observes it, plus the refresher. */
async function mountList() {
    const { queryClient, wrapper, readList } = setup();
    const hook = await renderHook(
        () => {
            useQuery({ queryKey: automationKeys.automations, queryFn: readList });
            return useSettledRunRefresh();
        },
        { wrapper },
    );
    await waitFor(() => expect(readList).toHaveBeenCalledTimes(1));
    return { ...hook, queryClient, readList };
}

describe('useSettledRunRefresh', () => {
    it('re-reads the list when a run finishes or fails', async () => {
        const { result, readList } = await mountList();
        await act(async () => result.current({ type: 'run.finished', automationId: 'a1' }));
        await waitFor(() => expect(readList).toHaveBeenCalledTimes(2));
        await act(async () => result.current({ type: 'run.failed', automationId: 'a1' }));
        await waitFor(() => expect(readList).toHaveBeenCalledTimes(3));
    });

    it('leaves the list alone for a start and for steps', async () => {
        const { result, queryClient, readList } = await mountList();
        const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
        await act(async () => {
            result.current({ type: 'run.started', automationId: 'a1' });
            result.current({ type: 'step.finished', automationId: 'a1' });
            result.current({ type: 'step.heartbeat', automationId: 'a1' });
        });
        expect(invalidate).not.toHaveBeenCalled();
        expect(readList).toHaveBeenCalledTimes(1);
    });

    it('joins a read already on its way when two screens hear the same end', async () => {
        const { result, readList } = await mountList();
        await act(async () => {
            result.current({ type: 'run.finished', automationId: 'a1' });
            result.current({ type: 'run.finished', automationId: 'a1' });
        });
        await waitFor(() => expect(readList).toHaveBeenCalledTimes(2));
        await act(async () => undefined);
        expect(readList).toHaveBeenCalledTimes(2);
    });
});
