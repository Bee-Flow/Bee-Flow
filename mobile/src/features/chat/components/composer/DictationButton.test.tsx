/**
 * The dictation mic after a refusal: a first refusal is said in a toast; a
 * microphone Android will no longer ask for offers its settings, and says so
 * when the person comes back with it allowed, without recording by itself.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import React from 'react';
import { Linking } from 'react-native';

import { appStateEmitter } from '@/shared/testing/appState';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { DictationButton } from './DictationButton';

jest.setTimeout(30_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const appState = appStateEmitter();

beforeEach(() => {
    jest.clearAllMocks();
    appState.install();
});

const tapMic = () => fireEvent.press(screen.getByLabelText('Dictate — speak your instruction'));

it('says the microphone is needed after a first refusal', async () => {
    jest.mocked(requestRecordingPermissionsAsync).mockResolvedValue({ granted: false, canAskAgain: true } as never);
    await renderScreen(<DictationButton onText={jest.fn()} />);
    await tapMic();
    expect(await screen.findByText('Bee Flow needs the microphone to take dictation.')).toBeTruthy();
    expect(screen.queryByText('Open Android settings')).toBeNull();
});

it('offers Android settings once the microphone is refused for good', async () => {
    jest.mocked(requestRecordingPermissionsAsync).mockResolvedValue({ granted: false, canAskAgain: false } as never);
    jest.mocked(getRecordingPermissionsAsync).mockResolvedValue({ granted: true, canAskAgain: true } as never);
    await renderScreen(<DictationButton onText={jest.fn()} />);
    await tapMic();
    expect(await screen.findByText('Microphone access is off')).toBeTruthy();
    await fireEvent.press(screen.getByText('Open Android settings'));
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);

    await appState.roundTrip();
    expect(await screen.findByText('The microphone is on. Tap it to dictate.')).toBeTruthy();
    expect(requestRecordingPermissionsAsync).toHaveBeenCalledTimes(1);
});
