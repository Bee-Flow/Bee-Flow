import { describe, it, expect } from 'vitest';
import { FALLBACK_IMAGE_MODELS, imageModelOptions, selectedImageModel } from './imageModelChoice';

const SERVER = [
    { id: 'gemini-3.1-flash-image-preview', label: 'Flash Image (Fast)', provider: 'google' as const },
    { id: 'azure/images-prod', label: 'gpt-image-1.5 (images-prod)', provider: 'azure' as const },
];

describe('the image model choice of the composer', () => {
    it('offers the server list, or the two Google models when there is none', () => {
        expect(imageModelOptions(SERVER)).toBe(SERVER);
        expect(imageModelOptions(null)).toBe(FALLBACK_IMAGE_MODELS);
        expect(imageModelOptions([])).toBe(FALLBACK_IMAGE_MODELS);
    });

    it('keeps a stored choice that is still offered, an Azure one too', () => {
        expect(selectedImageModel('azure/images-prod', SERVER)).toBe('azure/images-prod');
    });

    it('falls back to the first model when the stored one is gone', () => {
        expect(selectedImageModel('gemini-3-pro-image-preview', SERVER)).toBe('gemini-3.1-flash-image-preview');
        expect(selectedImageModel('azure/removed', [SERVER[1]])).toBe('azure/images-prod');
        expect(selectedImageModel(undefined, FALLBACK_IMAGE_MODELS)).toBe('gemini-3.1-flash-image-preview');
    });
});
