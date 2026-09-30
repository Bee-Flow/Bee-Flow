/**
 * Adding photos to a knowledge base opens Android's Photo Picker directly: no
 * media-library permission first (the manifest blocks it, so asking could
 * only be refused and the pick would never open), and the picked photos come
 * back as uploads.
 */

import * as ImagePicker from 'expo-image-picker';

import { pickImages } from './pickers';

// No media-library permission functions at all: calling one would throw.
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

describe('pickImages', () => {
    it('opens the library without asking and returns the picked photos', async () => {
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({
            canceled: false,
            assets: [{ uri: 'file:///a.png', fileName: 'a.png', mimeType: 'image/png', fileSize: 12 }],
        } as never);
        await expect(pickImages()).resolves.toEqual([{ uri: 'file:///a.png', name: 'a.png', mimeType: 'image/png', size: 12 }]);
    });

    it('returns nothing when the person backs out', async () => {
        jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: null } as never);
        await expect(pickImages()).resolves.toEqual([]);
    });
});
