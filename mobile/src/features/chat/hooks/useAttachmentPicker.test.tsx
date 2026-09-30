/**
 * The composer's photo doors on Android: the library opens with no permission
 * asked (the Photo Picker needs none, and the broad reads are blocked in the
 * manifest), and a camera Android will no longer ask for offers its settings
 * and takes the photo once the person is back with it allowed.
 *
 * And the picker refuses what could never be sent: a document larger than the
 * whole message's budget is turned away when it is picked, with the limit in
 * the toast, instead of riding along as a chip and failing after Send. A photo
 * of the same size stays, because it is shrunk before it is sent.
 */

import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import React, { type ReactNode } from 'react';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/core/theme/ThemeProvider';
import { ConfirmProvider } from '@/shared/patterns';
import { appStateEmitter } from '@/shared/testing/appState';
import { TEST_METRICS } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { useAttachmentPicker } from './useAttachmentPicker';

jest.setTimeout(30_000);

// No media-library permission functions at all: calling one would throw.
jest.mock('expo-image-picker', () => ({
    launchImageLibraryAsync: jest.fn(),
    launchCameraAsync: jest.fn(),
    requestCameraPermissionsAsync: jest.fn(),
    getCameraPermissionsAsync: jest.fn(),
}));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

const appState = appStateEmitter();
const MB = 1024 * 1024;
const PHOTO = { uri: 'file:///p.jpg', fileName: 'p.jpg', mimeType: 'image/jpeg', fileSize: 1000 };

function Providers({ children }: { children: ReactNode }) {
    return (
        <SafeAreaProvider initialMetrics={TEST_METRICS}>
            <ThemeProvider>
                <ToastProvider>
                    <ConfirmProvider>{children}</ConfirmProvider>
                </ToastProvider>
            </ThemeProvider>
        </SafeAreaProvider>
    );
}

const mount = async () => (await renderHook(() => useAttachmentPicker(), { wrapper: Providers })).result;

beforeEach(() => {
    jest.clearAllMocks();
    appState.install();
    jest.mocked(ImagePicker.launchCameraAsync).mockResolvedValue({ canceled: false, assets: [PHOTO] } as never);
});

it('opens the photo library without asking for a permission', async () => {
    jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: false, assets: [PHOTO] } as never);
    const result = await mount();
    await act(() => result.current.pickImage());
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    expect(result.current.attachments).toEqual([{ name: 'p.jpg', mimeType: 'image/jpeg', size: 1000, uri: 'file:///p.jpg' }]);
});

it('says the camera is needed after a first refusal, and sends nobody to settings', async () => {
    jest.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({ granted: false, canAskAgain: true } as never);
    const result = await mount();
    await act(() => result.current.takePhoto());
    expect(await screen.findByText('Bee Flow needs camera permission to take a photo')).toBeTruthy();
    expect(screen.queryByText('Open Android settings')).toBeNull();
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
});

it('offers Android settings once the camera is refused for good, and takes the photo on return', async () => {
    jest.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({ granted: false, canAskAgain: false } as never);
    jest.mocked(ImagePicker.getCameraPermissionsAsync).mockResolvedValue({ granted: true, canAskAgain: true } as never);
    const result = await mount();
    let taking: Promise<unknown> = Promise.resolve();
    await act(async () => {
        taking = result.current.takePhoto();
    });
    expect(await screen.findByText('Camera access is off')).toBeTruthy();
    await fireEvent.press(screen.getByText('Open Android settings'));
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();

    await appState.roundTrip();
    await act(() => taking);
    expect(ImagePicker.getCameraPermissionsAsync).toHaveBeenCalled();
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
});

it('leaves it there when the person declines the settings', async () => {
    jest.mocked(ImagePicker.requestCameraPermissionsAsync).mockResolvedValue({ granted: false, canAskAgain: false } as never);
    const result = await mount();
    let taking: Promise<unknown> = Promise.resolve();
    await act(async () => {
        taking = result.current.takePhoto();
    });
    await fireEvent.press(await screen.findByText('Cancel'));
    await act(() => taking);
    expect(Linking.openSettings).not.toHaveBeenCalled();
    expect(ImagePicker.launchCameraAsync).not.toHaveBeenCalled();
});

describe('size limits', () => {
    it('turns away a 15 MB document at pick time and says the limit', async () => {
        jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({
            canceled: false,
            assets: [
                { name: 'report.pdf', mimeType: 'application/pdf', size: 15 * MB, uri: 'file:///report.pdf' },
                { name: 'notes.pdf', mimeType: 'application/pdf', size: MB, uri: 'file:///notes.pdf' },
            ],
        } as never);
        const result = await mount();
        await act(() => result.current.pickDocument());
        expect(await screen.findByText('report.pdf is too large to attach: the limit is 12 MB.')).toBeTruthy();
        expect(result.current.attachments.map((a) => a.name)).toEqual(['notes.pdf']);
    });

    it('keeps a 15 MB photo, which is shrunk before it is sent', async () => {
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({
            canceled: false,
            assets: [{ uri: 'file:///big.jpg', fileName: 'big.jpg', mimeType: 'image/jpeg', fileSize: 15 * MB }],
        } as never);
        const result = await mount();
        await act(() => result.current.pickImage());
        expect(result.current.attachments.map((a) => a.name)).toEqual(['big.jpg']);
        expect(screen.queryByText(/too large to attach/)).toBeNull();
    });
});
