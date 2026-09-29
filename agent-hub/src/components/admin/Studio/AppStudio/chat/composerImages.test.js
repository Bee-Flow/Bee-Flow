import { beforeEach, describe, expect, it, vi } from 'vitest';

// The downscale path decodes through the browser (createImageBitmap / <img>),
// which jsdom cannot do — it never settles. Stub the shared helper so these
// tests exercise THIS module's validation and fallback logic, not canvas.
vi.mock('@/utils/imageResize', () => ({
    resizeImageForUpload: vi.fn(),
    readAsDataUrl: vi.fn(),
}));

import { readAsDataUrl, resizeImageForUpload } from '@/utils/imageResize';
import {
    MAX_IMAGES_PER_TURN,
    dataUrlBytes,
    imageFilesFrom,
    prepareComposerImages,
} from './composerImages';

const file = (name, type, bytes = 8) => new File([new Uint8Array(bytes)], name, { type });

/** A base64 data URL whose DECODED payload is `bytes` long. */
function dataUrlOfSize(bytes, mime = 'image/png') {
    const b64 = 'A'.repeat(Math.ceil(bytes / 3) * 4);
    return `data:${mime};base64,${b64}`;
}

beforeEach(() => {
    vi.clearAllMocks();
    // Default: the downscale succeeds and returns a small PNG.
    resizeImageForUpload.mockImplementation(async (f) => ({
        dataUrl: `data:${f.type};base64,AAAA`,
        mimeType: f.type,
    }));
    readAsDataUrl.mockImplementation(async (f) => `data:${f.type};base64,RAW=`);
});

describe('dataUrlBytes', () => {
    it('measures the decoded payload without allocating it', () => {
        expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3);
        expect(dataUrlBytes('data:image/png;base64,AAA=')).toBe(2);
        expect(dataUrlBytes('data:image/png;base64,AA==')).toBe(1);
        expect(dataUrlBytes('not a data url')).toBe(0);
    });
});

describe('imageFilesFrom', () => {
    it('pulls pasted screenshots out of clipboardData.items', () => {
        const png = file('shot.png', 'image/png');
        const clipboard = {
            items: [
                { kind: 'string', type: 'text/plain', getAsFile: () => null },
                { kind: 'file', type: 'image/png', getAsFile: () => png },
            ],
            files: [],
        };
        expect(imageFilesFrom(clipboard)).toEqual([png]);
    });

    it('falls back to .files when items carries nothing usable', () => {
        const jpg = file('a.jpg', 'image/jpeg');
        expect(imageFilesFrom({ items: [], files: [jpg] })).toEqual([jpg]);
    });

    it('ignores a text-only paste (so pasting text still behaves normally)', () => {
        const clipboard = { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], files: [] };
        expect(imageFilesFrom(clipboard)).toEqual([]);
        expect(imageFilesFrom(null)).toEqual([]);
    });
});

describe('prepareComposerImages', () => {
    it('stages a pasted PNG through the downscale path', async () => {
        const { images, errors } = await prepareComposerImages([file('shot.png', 'image/png')]);
        expect(errors).toEqual([]);
        expect(images).toHaveLength(1);
        expect(images[0]).toMatchObject({ name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' });
        expect(resizeImageForUpload).toHaveBeenCalledTimes(1);
    });

    it('falls back to the raw file when downscaling fails, rather than losing the screenshot', async () => {
        resizeImageForUpload.mockRejectedValueOnce(new Error('no canvas'));
        const { images, errors } = await prepareComposerImages([file('shot.png', 'image/png')]);
        expect(errors).toEqual([]);
        expect(images[0].dataUrl).toBe('data:image/png;base64,RAW=');
    });

    it('rejects a non-allowlisted type', async () => {
        const { images, errors } = await prepareComposerImages([file('diagram.svg', 'image/svg+xml')]);
        expect(images).toEqual([]);
        expect(errors[0]).toMatch(/PNG, JPEG, WebP or GIF/);
    });

    it('rejects an image over the 5 MB cap', async () => {
        resizeImageForUpload.mockResolvedValueOnce({ dataUrl: dataUrlOfSize(6 * 1024 * 1024), mimeType: 'image/png' });
        const { images, errors } = await prepareComposerImages([file('huge.png', 'image/png')]);
        expect(images).toEqual([]);
        expect(errors[0]).toMatch(/too large/);
    });

    it('caps the batch at MAX_IMAGES_PER_TURN and says so', async () => {
        const many = Array.from({ length: MAX_IMAGES_PER_TURN + 2 }, (_, i) => file(`s${i}.png`, 'image/png'));
        const { images, errors } = await prepareComposerImages(many);
        expect(images).toHaveLength(MAX_IMAGES_PER_TURN);
        expect(errors[0]).toMatch(new RegExp(`limit is ${MAX_IMAGES_PER_TURN}`));
    });

    it('counts images already staged against the budget', async () => {
        const { images, errors } = await prepareComposerImages(
            [file('a.png', 'image/png')],
            MAX_IMAGES_PER_TURN,
        );
        expect(images).toEqual([]);
        expect(errors[0]).toMatch(/at most 4 images/);
    });

    it('one unreadable file never swallows the rest of the batch', async () => {
        resizeImageForUpload.mockRejectedValueOnce(new Error('boom'));
        readAsDataUrl.mockRejectedValueOnce(new Error('boom'));
        const { images, errors } = await prepareComposerImages([
            file('broken.png', 'image/png'),
            file('good.png', 'image/png'),
        ]);
        expect(images).toHaveLength(1);
        expect(images[0].name).toBe('good.png');
        expect(errors[0]).toMatch(/could not be read/);
    });

    it('rejects a downscale that transcoded to something unsupported', async () => {
        resizeImageForUpload.mockResolvedValueOnce({ dataUrl: 'data:image/bmp;base64,AAAA', mimeType: 'image/bmp' });
        const { images, errors } = await prepareComposerImages([file('shot.png', 'image/png')]);
        expect(images).toEqual([]);
        expect(errors[0]).toMatch(/PNG, JPEG, WebP or GIF/);
    });

    it('is a no-op for an empty pick', async () => {
        expect(await prepareComposerImages([])).toEqual({ images: [], errors: [] });
        expect(await prepareComposerImages(null)).toEqual({ images: [], errors: [] });
    });
});
