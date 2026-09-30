/**
 * The document scanner's two Android dead ends, closed: a camera Android will
 * no longer ask for opens its settings (not a request that does nothing) and
 * shows the camera once the person is back with it allowed; and Back with
 * pages shot asks before throwing them away.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';

import { appStateEmitter } from '@/shared/testing/appState';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { ScanCamera } from './ScanCamera';

jest.setTimeout(30_000);

type Permission = { granted: boolean; canAskAgain: boolean; status: string };
const mockCamera = {
    permission: { granted: false, canAskAgain: true, status: 'undetermined' } as Permission,
    request: jest.fn<Promise<Permission>, []>(),
    get: jest.fn<Promise<Permission>, []>(),
};

jest.mock('expo-camera', () => {
    const { createElement, forwardRef, useImperativeHandle, useState } = jest.requireActual('react');
    const { View } = jest.requireActual('react-native');
    return {
        useCameraPermissions: () => {
            const [permission, setPermission] = useState(mockCamera.permission);
            const run = (read: () => Promise<Permission>) => async () => {
                const next = await read();
                setPermission(next);
                return next;
            };
            return [permission, run(mockCamera.request), run(mockCamera.get)];
        },
        CameraView: forwardRef((_props: object, ref: unknown) => {
            useImperativeHandle(ref, () => ({
                takePictureAsync: async () => ({ uri: `file:///page-${Math.random()}.jpg`, width: 10, height: 14 }),
            }));
            return createElement(View, { testID: 'camera' });
        }),
    };
});

const GRANTED: Permission = { granted: true, canAskAgain: true, status: 'granted' };
const BLOCKED: Permission = { granted: false, canAskAgain: false, status: 'denied' };
const appState = appStateEmitter();

beforeEach(() => {
    jest.clearAllMocks();
    appState.install();
});

const open = (onClose = jest.fn()) =>
    renderScreen(<ScanCamera visible onClose={onClose} onCapture={jest.fn()} />).then(() => onClose);

describe('camera access', () => {
    it('asks Android while it still will', async () => {
        mockCamera.permission = { granted: false, canAskAgain: true, status: 'undetermined' };
        mockCamera.request.mockResolvedValue(GRANTED);
        await open();
        await fireEvent.press(await screen.findByText('Allow camera'));
        expect(mockCamera.request).toHaveBeenCalledTimes(1);
        expect(Linking.openSettings).not.toHaveBeenCalled();
        expect(await screen.findByTestId('camera')).toBeTruthy();
    });

    it('opens Android settings once it will not, and shows the camera when the person is back', async () => {
        mockCamera.permission = BLOCKED;
        mockCamera.get.mockResolvedValue(GRANTED);
        await open();
        expect(await screen.findByText("Android will not ask again. Allow the camera in Bee Flow's settings, then come back here.")).toBeTruthy();
        await fireEvent.press(screen.getByText('Open Android settings'));
        expect(Linking.openSettings).toHaveBeenCalledTimes(1);
        expect(mockCamera.request).not.toHaveBeenCalled();

        await appState.roundTrip();
        expect(await screen.findByTestId('camera')).toBeTruthy();
    });

    it('reads the permission again whenever the app comes back to the front', async () => {
        mockCamera.permission = BLOCKED;
        mockCamera.get.mockResolvedValue(GRANTED);
        await open();
        await screen.findByText('Open Android settings');
        await appState.roundTrip();
        expect(await screen.findByTestId('camera')).toBeTruthy();
    });
});

describe('leaving', () => {
    beforeEach(() => {
        mockCamera.permission = GRANTED;
    });

    const back = () => fireEvent(screen.getByTestId('camera'), 'requestClose');

    it('closes at once with nothing shot', async () => {
        const onClose = await open();
        await screen.findByTestId('camera');
        await back();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('Discard this scan?')).toBeNull();
    });

    it('asks before Back throws shot pages away', async () => {
        const onClose = await open();
        await fireEvent.press(await screen.findByLabelText('Capture this page'));
        await waitFor(() => expect(screen.getByLabelText('Discard page 1')).toBeTruthy());

        await back();
        expect(await screen.findByText('The page you scanned is not uploaded yet and will be lost.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Cancel'));
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Discard page 1')).toBeTruthy();

        await fireEvent.press(screen.getByLabelText('Close the scanner'));
        await fireEvent.press(await screen.findByText('Discard'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
