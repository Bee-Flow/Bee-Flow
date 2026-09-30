/**
 * The language choice has to take effect. It did not: the screen saved it
 * under a key the i18n store never read, and the resolved locale was cached
 * for good, so nothing re-resolved even when the key was right.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { storedLocale } from '@/core/i18n';
import { testQueryClient } from '@/shared/testing/renderWithProviders';

import { useLocalePreference } from './useLocalePreference';

async function draw() {
    const queryClient = testQueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const hook = await renderHook(() => useLocalePreference(), { wrapper });
    await waitFor(() => expect(hook.result.current.hydrated).toBe(true));
    return { ...hook, invalidate };
}

beforeEach(async () => {
    await AsyncStorage.clear();
});

it('saves a choice where the i18n store reads it, and re-resolves the locale', async () => {
    const { result, invalidate } = await draw();
    await act(async () => result.current.choose('nl'));

    expect(await storedLocale()).toBe('nl');
    expect(result.current.preference).toBe('nl');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['i18n', 'resolved'] });
});

it('clears the choice to follow the phone again', async () => {
    await AsyncStorage.setItem('beeflow.i18n.choice', 'de');
    const { result, invalidate } = await draw();
    expect(result.current.preference).toBe('de');

    await act(async () => result.current.choose(null));
    expect(await storedLocale()).toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(1);
});
