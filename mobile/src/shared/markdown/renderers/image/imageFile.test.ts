/**
 * A picture from an answer, handed to the share sheet or saved where the
 * person picks: from expo-image's disk cache (no second download), or from
 * its own bytes for an inline data: image.
 */

import { Directory } from 'expo-file-system';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';

import { imageFileName, imageMimeType, localImage, readDataUri, saveImage, shareImage } from './imageFile';

const written: { name: string; content: unknown; options?: unknown }[] = [];

jest.mock('expo-file-system', () => {
    class MockFile {
        uri: string;
        exists = false;
        name: string;
        constructor(...parts: unknown[]) {
            const last = parts[parts.length - 1];
            this.name = String(last);
            this.uri = parts.map((p) => (typeof p === 'string' ? p : ((p as { uri?: string }).uri ?? 'cache'))).join('/');
        }
        create() {}
        delete() {}
        write(content: unknown, options?: unknown) {
            written.push({ name: this.name, content, options });
        }
        async bytes() {
            return new Uint8Array([1, 2, 3]);
        }
    }
    return {
        File: MockFile,
        Paths: { cache: { uri: 'file:///cache' } },
        Directory: {
            pickDirectoryAsync: jest.fn(async () => ({ createFile: (name: string) => new MockFile('content://picked', name) })),
        },
    };
});
jest.mock('expo-image', () => ({ Image: { getCachePathAsync: jest.fn(async () => '/data/cache/img.png') } }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));

beforeEach(() => {
    written.length = 0;
    jest.clearAllMocks();
});

describe('names and types', () => {
    it('keeps a URL’s own file name, and names anything else as the web does', () => {
        expect(imageFileName('https://cdn.example.com/charts/q3%20sales.png?x=1', 7)).toBe('q3 sales.png');
        expect(imageFileName('/api/storage/abc', 7)).toBe('ai-image-7.png');
        expect(imageFileName('data:image/jpeg;base64,AAAA', 7)).toBe('ai-image-7.jpg');
        // A malformed escape is kept as written, and made safe for the file system.
        expect(imageFileName('https://x.example/%E0%A4%A.png', 7)).toBe('_E0_A4_A.png');
    });

    it('reads a data URI and a type from a name', () => {
        expect(readDataUri('data:image/png;base64,QUJD')).toEqual({ mime: 'image/png', base64: 'QUJD' });
        expect(readDataUri('https://x/y.png')).toBeNull();
        expect(imageMimeType('a.webp')).toBe('image/webp');
        expect(imageMimeType('a.unknown')).toBe('image/png');
    });
});

describe('localImage', () => {
    it('takes a drawn picture from expo-image’s cache', async () => {
        const file = await localImage('https://cdn.example.com/c.png', 'c.png');
        expect(Image.getCachePathAsync).toHaveBeenCalledWith('https://cdn.example.com/c.png');
        expect(file?.uri).toBe('file:///data/cache/img.png');
    });

    it('writes an inline image’s own bytes', async () => {
        await localImage('data:image/png;base64,QUJD', 'x.png');
        expect(written).toEqual([{ name: 'x.png', content: 'QUJD', options: { encoding: 'base64' } }]);
    });

    it('has nothing for a picture that was never drawn', async () => {
        (Image.getCachePathAsync as jest.Mock).mockResolvedValueOnce(null);
        expect(await localImage('https://x/y.png', 'y.png')).toBeNull();
    });
});

describe('share and save', () => {
    it('shares the cached file with its type', async () => {
        expect(await shareImage('https://cdn.example.com/c.png')).toBe('done');
        expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///data/cache/img.png', { mimeType: 'image/png', dialogTitle: 'c.png' });
    });

    it('saves into the folder the person picks', async () => {
        expect(await saveImage('https://cdn.example.com/c.png')).toBe('done');
        expect(written).toEqual([{ name: 'c.png', content: new Uint8Array([1, 2, 3]), options: undefined }]);
    });

    it('says so when the picker is dismissed or the picture is not on the phone', async () => {
        (Directory.pickDirectoryAsync as jest.Mock).mockRejectedValueOnce(new Error('cancelled'));
        expect(await saveImage('https://cdn.example.com/c.png')).toBe('cancelled');
        (Image.getCachePathAsync as jest.Mock).mockResolvedValueOnce(null);
        expect(await shareImage('https://x/y.png')).toBe('unavailable');
    });
});
