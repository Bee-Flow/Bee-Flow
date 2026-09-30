/**
 * Which catalogue is on screen across a sign-in: the public one on the login,
 * the account's once signed in — and the account's again on the next sign-in,
 * even when it answers from cache after a sign-out put the public one back.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import type { AuthStage } from '@/core/auth/types';
import { translate, _reset } from '@/core/i18n';
import { testQueryClient } from '@/shared/testing/renderWithProviders';

import { LocaleSync } from './LocaleSync';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/server', () => ({
    ...jest.requireActual('@/core/api/server'),
    getServerUrl: () => 'https://beeflow.example',
}));

let mockStage: AuthStage = { kind: 'signed-out', oauthProviders: [], isOAuthConfigured: false };
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ stage: mockStage }) }));

const SERVER: Record<string, unknown> = {
    '/api/languages/public/locales': [{ code: 'en' }, { code: 'nl' }],
    '/api/languages/public/strings/nl': { 'login.password': 'Wachtwoord (public)' },
    '/api/languages/user/locales': [{ code: 'en' }, { code: 'nl', isOrgDefault: true }],
    '/api/languages/user/strings/nl': { 'login.password': 'Wachtwoord (account)' },
};

const password = () => translate('login.password', 'Password');
const signedIn: AuthStage = { kind: 'signed-in', user: { id: 'u1', username: 'tom', displayName: 'Tom' } as never };
const signedOut: AuthStage = { kind: 'signed-out', oauthProviders: [], isOAuthConfigured: false };

beforeEach(async () => {
    _reset();
    await AsyncStorage.clear();
    // The login resolves Dutch from the stored choice: the org default is not public.
    await AsyncStorage.setItem('beeflow.i18n.choice', 'nl');
    (api.get as jest.Mock).mockImplementation(async (path: string) => SERVER[path] ?? null);
    mockStage = signedOut;
});

it('shows the public catalogue on the login and the account’s after every sign-in', async () => {
    const queryClient = testQueryClient();
    const ui = () => (
        <QueryClientProvider client={queryClient}>
            <LocaleSync />
        </QueryClientProvider>
    );
    const view = await render(ui());
    await waitFor(() => expect(password()).toBe('Wachtwoord (public)'));

    mockStage = signedIn;
    await view.rerender(ui());
    await waitFor(() => expect(password()).toBe('Wachtwoord (account)'));

    mockStage = signedOut;
    await view.rerender(ui());
    await waitFor(() => expect(password()).toBe('Wachtwoord (public)'));

    // The account's queries answer from cache this time; it still has to win.
    mockStage = signedIn;
    await view.rerender(ui());
    await waitFor(() => expect(password()).toBe('Wachtwoord (account)'));
});
