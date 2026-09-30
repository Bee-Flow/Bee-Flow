/**
 * The empty inbox gives the right reason: a missing notification permission
 * is offered as that (Android's dialog, or its settings once it will not ask),
 * and only a refused background check is reported as Android refusing
 * background work.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import React from 'react';
import { Linking } from 'react-native';

import { appStateEmitter } from '@/shared/testing/appState';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { NotificationsEmpty } from './NotificationsEmpty';
import { registerNotificationPolling, startAnnouncing } from '../background';

jest.setTimeout(30_000);

jest.mock('expo-notifications', () => ({
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
}));
jest.mock('../background', () => ({
    registerNotificationPolling: jest.fn(async () => true),
    startAnnouncing: jest.fn(async () => true),
}));

const appState = appStateEmitter();
const RESTRICTED = 'Android is not allowing background work for Bee Flow';

beforeEach(() => {
    jest.clearAllMocks();
    appState.install();
});

const inbox = () => renderScreen(<NotificationsEmpty unreadOnly={false} onShowAll={jest.fn()} />);

it('offers the permission, not background work, while notifications are not allowed', async () => {
    jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: 'denied', granted: false, canAskAgain: true } as never);
    jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue({ status: 'denied', granted: false, canAskAgain: true } as never);
    await inbox();
    expect(await screen.findByText(/Allow notifications to hear about it while the app is closed\./)).toBeTruthy();
    await fireEvent.press(screen.getByText('Allow notifications'));
    await waitFor(() => expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1));
    expect(Linking.openSettings).not.toHaveBeenCalled();
    expect(registerNotificationPolling).not.toHaveBeenCalled();
    expect(screen.queryByText(RESTRICTED)).toBeNull();
});

it('opens Android settings once Android will not ask, and starts once allowed there', async () => {
    jest.mocked(Notifications.getPermissionsAsync)
        .mockResolvedValueOnce({ status: 'denied', granted: false, canAskAgain: false } as never)
        .mockResolvedValueOnce({ status: 'denied', granted: false, canAskAgain: false } as never)
        .mockResolvedValue({ status: 'granted', granted: true, canAskAgain: true } as never);
    await inbox();
    await fireEvent.press(await screen.findByText('Open Android settings'));
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    await appState.roundTrip();
    expect(await screen.findByText('Bee Flow will check for updates in the background')).toBeTruthy();
    expect(startAnnouncing).toHaveBeenCalledTimes(1);
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
});

it('says Android refuses background work only when it does', async () => {
    jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: 'granted', granted: true, canAskAgain: true } as never);
    jest.mocked(registerNotificationPolling).mockResolvedValueOnce(false);
    await inbox();
    await fireEvent.press(await screen.findByText('Turn on background alerts'));
    expect(await screen.findByText(RESTRICTED)).toBeTruthy();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
});
