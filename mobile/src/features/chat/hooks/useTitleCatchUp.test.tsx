/**
 * A new chat's name, looked up after the turn: the conversation and the list
 * are read again while the chat has no name, not after it has one, and not
 * once the screen is gone.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { testQueryClient } from '@/shared/testing/renderWithProviders';

import { useTitleCatchUp } from './useTitleCatchUp';
import { chatKeys } from '../api/keys';
import { awaitsTitle, TITLE_CHECKS_MS } from '../model/titleCatchUp';

const [FIRST = 0, LAST = 0] = TITLE_CHECKS_MS;

async function mount() {
    const queryClient = testQueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const hook = await renderHook(() => useTitleCatchUp(), { wrapper });
    jest.useFakeTimers();
    const keysRead = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    return { queryClient, hook, keysRead };
}

afterEach(() => jest.useRealTimers());

describe('awaitsTitle', () => {
    it("is the server's test for a chat still waiting for its name", () => {
        expect(awaitsTitle(null)).toBe(true);
        expect(awaitsTitle('  ')).toBe(true);
        expect(awaitsTitle('New Chat')).toBe(true);
        expect(awaitsTitle('Notice periods')).toBe(false);
    });
});

it('reads the conversation and the list again a few seconds after the turn, and again while the name is missing', async () => {
    const { hook, keysRead } = await mount();
    await act(async () => hook.result.current('c1'));
    expect(keysRead()).toEqual([]);

    await act(async () => jest.advanceTimersByTime(FIRST));
    expect(keysRead()).toEqual([chatKeys.conversation('c1'), chatKeys.conversations]);

    await act(async () => jest.advanceTimersByTime(LAST - FIRST));
    expect(keysRead()).toHaveLength(4);
});

it('stops looking once the name has landed', async () => {
    const { queryClient, hook, keysRead } = await mount();
    await act(async () => hook.result.current('c1'));
    queryClient.setQueryData(chatKeys.conversation('c1'), { id: 'c1', title: 'Notice periods', messages: [] });
    await act(async () => jest.advanceTimersByTime(LAST));
    expect(keysRead()).toEqual([]);
});

it('looks no more once the screen is gone', async () => {
    const { hook, keysRead } = await mount();
    await act(async () => hook.result.current('c1'));
    await hook.unmount();
    await act(async () => jest.advanceTimersByTime(LAST));
    expect(keysRead()).toEqual([]);
});
