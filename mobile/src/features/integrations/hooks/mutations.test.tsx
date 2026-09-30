/**
 * The allow-list toggle is optimistic: the switch moves before the server
 * answers, a refusal puts the previous list back, and either way the settle
 * re-reads the server's answer under the same key.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { useSaveEnabledApps } from './mutations';
import { saveUserSettings } from '../api/endpoints';
import { integrationKeys } from '../api/keys';

jest.mock('../api/endpoints', () => ({
    saveUserSettings: jest.fn(),
    disconnectIntegration: jest.fn(),
    connectGithub: jest.fn(),
}));

const save = saveUserSettings as jest.MockedFunction<typeof saveUserSettings>;

function setup() {
    // Infinite gcTime for mutations too: a finished mutation otherwise leaves a
    // five-minute garbage-collection timer that keeps Jest from exiting.
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: Infinity },
            mutations: { retry: false, gcTime: Infinity },
        },
    });
    queryClient.setQueryData(integrationKeys.userSettings, { enabledApps: ['gmail'], simpleMode: false });
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return { queryClient, wrapper };
}

describe('useSaveEnabledApps', () => {
    afterEach(() => save.mockReset());

    it('shows the new list at once and keeps the rest of the settings', async () => {
        let finish: () => void = () => undefined;
        save.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
        const { queryClient, wrapper } = setup();
        const { result } = await renderHook(() => useSaveEnabledApps(), { wrapper });

        await act(async () => result.current.mutate(['gmail', 'drive']));
        await waitFor(() =>
            expect(queryClient.getQueryData(integrationKeys.userSettings)).toEqual({
                enabledApps: ['gmail', 'drive'],
                simpleMode: false,
            }),
        );
        expect(save).toHaveBeenCalledWith({ enabledApps: ['gmail', 'drive'] });
        await act(async () => finish());
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    it('puts the previous list back when the server refuses', async () => {
        save.mockRejectedValue(new Error('refused'));
        const { queryClient, wrapper } = setup();
        const { result } = await renderHook(() => useSaveEnabledApps(), { wrapper });

        await act(async () => result.current.mutate([]));
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(queryClient.getQueryData(integrationKeys.userSettings)).toEqual({
            enabledApps: ['gmail'],
            simpleMode: false,
        });
    });
});
