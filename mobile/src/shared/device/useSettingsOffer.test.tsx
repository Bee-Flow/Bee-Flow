/**
 * The offer of Android's settings for a permission it will no longer ask for:
 * declined, nothing opens; accepted, the settings page opens and the answer
 * comes only once the person is back in the app.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import { ConfirmProvider } from '@/shared/patterns';
import { appStateEmitter } from '@/shared/testing/appState';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { useSettingsOffer, type SettingsOffer } from './useSettingsOffer';

jest.setTimeout(30_000);

const appState = appStateEmitter();
beforeEach(() => appState.install());

async function mountOffer(): Promise<SettingsOffer> {
    let offer: SettingsOffer | null = null;
    function Probe() {
        offer = useSettingsOffer();
        return null;
    }
    await renderWithProviders(
        <ConfirmProvider>
            <Probe />
        </ConfirmProvider>,
    );
    return (...args) => (offer as unknown as SettingsOffer)(...args);
}

it('says what is off and opens nothing when declined', async () => {
    const offer = await mountOffer();
    let answer: boolean | null = null;
    await act(async () => {
        void offer('camera').then((ok) => (answer = ok));
    });
    expect(await screen.findByText('Camera access is off')).toBeTruthy();
    await fireEvent.press(screen.getByText('Cancel'));
    expect(answer).toBe(false);
    expect(Linking.openSettings).not.toHaveBeenCalled();
});

it('opens Android settings and answers once the person is back', async () => {
    const offer = await mountOffer();
    let answer: boolean | null = null;
    await act(async () => {
        void offer('microphone').then((ok) => (answer = ok));
    });
    expect(await screen.findByText('Microphone access is off')).toBeTruthy();
    await fireEvent.press(screen.getByText('Open Android settings'));
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    expect(answer).toBeNull();
    await appState.roundTrip();
    await act(async () => undefined);
    expect(answer).toBe(true);
});
