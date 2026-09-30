/**
 * The sheet and the keyboard. The dock is laid out from the bottom of the
 * screen, so it is lifted with padding: the panel ends where the keyboard
 * starts, and the relayout that padding causes measures the same overlap
 * again instead of adding it a second time (which is what `height` did, until
 * the dock was gone). Run as Android, the only platform the app ships to: the
 * keyboard events and the view's arithmetic both differ by platform.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { DeviceEventEmitter, Platform, StyleSheet, Text } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { Sheet } from './Sheet';

jest.setTimeout(30_000);

beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
});

const SCREEN = 844;
const KEYBOARD = 300;
const SHEET = 400;

async function layout(y: number, height: number) {
    await fireEvent(screen.getByTestId('sheet-dock'), 'layout', {
        persist: () => {},
        nativeEvent: { layout: { x: 0, y, width: 390, height } },
    });
}

async function keyboard(shown: boolean) {
    const height = shown ? KEYBOARD : 0;
    const event = { endCoordinates: { screenX: 0, screenY: SCREEN - height, width: 390, height } };
    await act(async () => {
        DeviceEventEmitter.emit(shown ? 'keyboardDidShow' : 'keyboardDidHide', event);
    });
}

const dockStyle = () => StyleSheet.flatten(screen.getByTestId('sheet-dock').props.style);

describe('Sheet', () => {
    it('lifts the panel above the keyboard with padding, and keeps it there after the relayout', async () => {
        await renderWithProviders(
            <Sheet visible onClose={jest.fn()} title="Rename">
                <Text>Body</Text>
            </Sheet>,
        );
        expect(screen.getByText('Rename')).toBeTruthy();
        await layout(SCREEN - SHEET, SHEET);

        await keyboard(true);
        expect(dockStyle()).toMatchObject({ paddingBottom: KEYBOARD });
        expect(dockStyle().height).toBeUndefined();

        // The dock grew by its padding; its bottom edge is still the screen's.
        await layout(SCREEN - SHEET - KEYBOARD, SHEET + KEYBOARD);
        expect(dockStyle()).toMatchObject({ paddingBottom: KEYBOARD });

        await keyboard(false);
        expect(dockStyle()).toMatchObject({ paddingBottom: 0 });
    });
});
