/** A 401 resets the session: the vault locks, the cache empties, and the session's permissions go. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { setUnauthorizedHandler } from '@/core/api/client';

import { useUnauthorizedReset } from './useSessionLifecycle';

jest.mock('@/core/api/client', () => ({ setUnauthorizedHandler: jest.fn() }));
jest.mock('./sessionToken', () => ({
    clearSessionToken: jest.fn(async () => undefined),
    primeSessionToken: jest.fn(),
    renewIfStale: jest.fn(),
    REFRESH_AFTER_MS: 60_000,
}));
jest.mock('./vault', () => ({ lock: jest.fn() }));

describe('useUnauthorizedReset', () => {
    it('forgets the session’s permissions along with its cache', async () => {
        const client = new QueryClient();
        client.setQueryData(['x'], 1);
        const forget = jest.fn();
        const resolve = jest.fn(async () => undefined);
        const wrapper = ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        await renderHook(() => useUnauthorizedReset(resolve, forget), { wrapper });
        const handler = (setUnauthorizedHandler as jest.Mock).mock.calls.at(-1)?.[0] as () => void;
        handler();
        expect(forget).toHaveBeenCalledTimes(1);
        expect(client.getQueryData(['x'])).toBeUndefined();
    });
});
