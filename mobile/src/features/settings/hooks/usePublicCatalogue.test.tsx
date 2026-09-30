/**
 * The sign-in screens' catalogue, fetched before there is a session: from the
 * public endpoints, into the same store the signed-in path fills, and never
 * after the stage has moved on to signed-in.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { api, ApiError } from '@/core/api/client';
import { currentLocale, setCatalogue, translate, _reset } from '@/core/i18n';

import { usePublicCatalogue } from './usePublicCatalogue';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

let mockServer: string | null = 'https://beeflow.example';
jest.mock('@/core/api/server', () => ({
    ...jest.requireActual('@/core/api/server'),
    getServerUrl: () => mockServer,
}));

let mockDevice = 'nl';
jest.mock('expo-localization', () => ({
    __esModule: true,
    getLocales: () => [{ languageCode: mockDevice }],
    getCalendars: () => [{ timeZone: 'Europe/Amsterdam' }],
}));

const get = api.get as jest.Mock;
const LOCALES = '/api/languages/public/locales';
const OFFERED = [
    { code: 'en', name: 'English' },
    { code: 'nl', name: 'Nederlands' },
];

/** The server's two public answers; `strings` may be a value, an error or a pending promise. */
function answer(strings: unknown) {
    get.mockImplementation(async (path: string) => {
        if (path === LOCALES) return OFFERED;
        if (strings instanceof Error) throw strings;
        return strings;
    });
}

const password = () => translate('login.password', 'Password');
/** setCatalogue persists without awaiting; let those writes land. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
    get.mockReset();
    mockServer = 'https://beeflow.example';
    mockDevice = 'nl';
    _reset();
    await AsyncStorage.clear();
});

describe('usePublicCatalogue', () => {
    it('puts a Dutch phone’s login in Dutch, from the public endpoints', async () => {
        answer({ 'login.password': 'Wachtwoord' });
        await renderHook(() => usePublicCatalogue(true));
        await waitFor(() => expect(password()).toBe('Wachtwoord'));
        expect(currentLocale()).toBe('nl');
        expect(get.mock.calls.map(([path]) => path)).toEqual([LOCALES, '/api/languages/public/strings/nl']);
    });

    it('installs English when the server has no strings for the language (404)', async () => {
        setCatalogue('nl', { 'login.password': 'Wachtwoord' });
        await settle();
        answer(new ApiError('Locale not available', { status: 404 }));
        await renderHook(() => usePublicCatalogue(true));
        await waitFor(() => expect(currentLocale()).toBe('en'));
        expect(password()).toBe('Password');
    });

    it('leaves the cached catalogue on screen when the server cannot be asked', async () => {
        setCatalogue('nl', { 'login.password': 'Wachtwoord' });
        await settle();
        answer(new Error('Network request failed'));
        await renderHook(() => usePublicCatalogue(true));
        await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
        await act(settle);
        expect(password()).toBe('Wachtwoord');
    });

    it('does not take a proxy’s page for an empty catalogue', async () => {
        setCatalogue('nl', { 'login.password': 'Wachtwoord' });
        await settle();
        answer('<html>Sign in to the Wi-Fi</html>');
        await renderHook(() => usePublicCatalogue(true));
        await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
        await act(settle);
        expect(password()).toBe('Wachtwoord');
    });

    it('asks nothing while signed in, or before a server is known', async () => {
        answer({ 'login.password': 'Wachtwoord' });
        await renderHook(() => usePublicCatalogue(false));
        mockServer = null;
        await renderHook(() => usePublicCatalogue(true));
        await act(settle);
        expect(get).not.toHaveBeenCalled();
        expect(password()).toBe('Password');
    });

    it('drops an answer that lands after sign-in, so the account’s catalogue wins', async () => {
        let release: (value: unknown) => void = () => undefined;
        answer(new Promise((resolve) => (release = resolve)));
        const hook = await renderHook(({ active }: { active: boolean }) => usePublicCatalogue(active), {
            initialProps: { active: true },
        });
        await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

        await hook.rerender({ active: false });
        setCatalogue('nl', { 'login.password': 'Wachtwoord (account)' });
        await act(async () => {
            release({ 'login.password': 'Wachtwoord (public)' });
            await settle();
        });
        expect(password()).toBe('Wachtwoord (account)');
    });
});
