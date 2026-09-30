import { screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { AppLockGroup } from './AppLockGroup';
import type { AppLock } from '../hooks/useAppLock';

jest.setTimeout(30_000);

const lock = (over: Partial<AppLock> = {}): AppLock => ({
    available: true,
    enabled: false,
    biometricKind: 'your fingerprint',
    error: null,
    toggle: jest.fn(async () => undefined),
    ...over,
});

describe('AppLockGroup', () => {
    it('says plainly what app lock off means, and promises no relock', async () => {
        await renderWithProviders(<AppLockGroup lock={lock()} />);
        expect(screen.getByText(/With app lock off, anyone who can open this phone can open Bee Flow/)).toBeTruthy();
        expect(screen.queryByText(/asks for your password every time/)).toBeNull();
        expect(screen.queryByText('Relocks after')).toBeNull();
    });

    it('shows the relock only while the lock is on', async () => {
        await renderWithProviders(<AppLockGroup lock={lock({ enabled: true })} />);
        expect(screen.getByText('Relocks after')).toBeTruthy();
        expect(screen.getByText(/released only after your fingerprint/)).toBeTruthy();
    });
});
