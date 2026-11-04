/**
 * The way back from a microphone Android will no longer ask for: after "Open
 * app settings" and allowing it there, the card goes away and Start recording
 * appears once the person is back, without restarting the app.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import { getRecordingPermissionsAsync } from 'expo-audio';
import React, { useEffect } from 'react';
import { Linking } from 'react-native';

import { useMicPermission } from '@/shared/device/useMicPermission';
import { appStateEmitter } from '@/shared/testing/appState';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { RecordStartBar } from './RecordStartBar';
import type { Recorder } from '../hooks/useRecorder';

jest.setTimeout(30_000);

const appState = appStateEmitter();
const readPermission = jest.mocked(getRecordingPermissionsAsync);
type PermissionRead = Awaited<ReturnType<typeof getRecordingPermissionsAsync>>;
const answer = (granted: boolean, canAskAgain: boolean) => ({ granted, canAskAgain }) as PermissionRead;

/** The real permission hook behind the bar; the tab reads it once on mount. */
function Harness() {
    const mic = useMicPermission(jest.fn());
    const { refreshPermission } = mic;
    useEffect(() => {
        void refreshPermission();
    }, [refreshPermission]);
    const recorder = { ...mic, start: jest.fn(async () => true) } as unknown as Recorder;
    return <RecordStartBar recorder={recorder} requesting={false} onRequestPermission={jest.fn()} />;
}

beforeEach(() => {
    jest.clearAllMocks();
    appState.install();
});

describe('RecordStartBar microphone access', () => {
    it('shows Start recording once the person is back from allowing the microphone in settings', async () => {
        readPermission.mockResolvedValue(answer(false, false));
        await renderWithProviders(<Harness />);
        expect(await screen.findByText('Microphone access is off')).toBeTruthy();

        await fireEvent.press(screen.getByText('Open app settings'));
        expect(Linking.openSettings).toHaveBeenCalledTimes(1);

        readPermission.mockResolvedValue(answer(true, true));
        await appState.roundTrip();

        expect(await screen.findByText('Start recording')).toBeTruthy();
        expect(screen.queryByText('Microphone access is off')).toBeNull();
    });

    it('stops listening for the return once the microphone is allowed', async () => {
        readPermission.mockResolvedValue(answer(true, true));
        await renderWithProviders(<Harness />);
        expect(await screen.findByText('Start recording')).toBeTruthy();
        expect(appState.listeners.size).toBe(0);
    });
});
