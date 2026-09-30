import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react-native';
import React from 'react';

import { useCatalogOnReturn } from './useCatalogOnReturn';
import { flowKeys } from '../api/keys';

const listeners: Record<string, (() => void)[]> = {};
jest.mock('expo-router', () => ({
    useNavigation: () => ({
        addListener: (event: string, fn: () => void) => {
            (listeners[event] ??= []).push(fn);
            return () => undefined;
        },
    }),
}));

const emit = (event: string) => act(() => (listeners[event] ?? []).forEach((fn) => fn()));

function Probe() {
    useCatalogOnReturn();
    return null;
}

describe('useCatalogOnReturn', () => {
    it('reads the catalog again after the author left the step editor and came back, not on opening it', async () => {
        const client = new QueryClient();
        const invalidate = jest.spyOn(client, 'invalidateQueries');
        await render(
            <QueryClientProvider client={client}>
                <Probe />
            </QueryClientProvider>,
        );
        await emit('focus');
        expect(invalidate).not.toHaveBeenCalled();
        await emit('blur');
        await emit('focus');
        expect(invalidate).toHaveBeenCalledWith({ queryKey: flowKeys.catalog, exact: true });
    });
});
