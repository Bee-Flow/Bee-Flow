/**
 * Picking an avatar opens Android's Photo Picker directly — no media-library
 * permission first, which the manifest blocks, so asking could only be
 * refused — and hands back the squared photo as a data URI.
 */

import * as ImagePicker from 'expo-image-picker';

import { usePickAvatar } from './usePickAvatar';

// No media-library permission functions at all: calling one would throw.
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));

it('opens the library without asking and hands back a data URI', async () => {
    jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({
        canceled: false,
        assets: [{ uri: 'file:///me.jpg', mimeType: 'image/jpeg', base64: 'QUJD' }],
    } as never);
    const onPicked = jest.fn();
    await usePickAvatar(onPicked)();
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ allowsEditing: true, aspect: [1, 1], base64: true }));
    expect(onPicked).toHaveBeenCalledWith('data:image/jpeg;base64,QUJD');
});
