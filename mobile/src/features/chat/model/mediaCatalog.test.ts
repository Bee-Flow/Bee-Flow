/** Which generators the composer offers, and which image models. */

import { IMAGE_MODELS, imageModelOptions, mediaGatesFor } from './mediaCatalog';

const FLAGS = { orgEnabledIntegrations: null, hasGoogleKey: false, hasElevenLabsKey: false };

it('offers images when the server says an image model is configured, Google or Azure', () => {
    expect(mediaGatesFor({ ...FLAGS, hasImageGen: true })).toEqual({ image: true, music: false, elevenlabs: false, video: false });
    expect(mediaGatesFor({ ...FLAGS, hasGoogleKey: true, hasImageGen: false }).image).toBe(false);
});

it('keeps music and video on the Google key', () => {
    expect(mediaGatesFor({ ...FLAGS, hasGoogleKey: true, hasImageGen: true })).toEqual({ image: true, music: true, elevenlabs: false, video: true });
});

it('follows the Google key for images when an older server does not say', () => {
    expect(mediaGatesFor({ ...FLAGS, hasGoogleKey: true }).image).toBe(true);
    expect(mediaGatesFor(FLAGS).image).toBe(false);
});

it('offers nothing the org switched off, and nothing before the flags arrive', () => {
    expect(mediaGatesFor({ ...FLAGS, orgEnabledIntegrations: ['music-gen'], hasGoogleKey: true, hasImageGen: true })).toEqual({
        image: false,
        music: true,
        elevenlabs: false,
        video: false,
    });
    expect(mediaGatesFor(null)).toEqual({ image: false, music: false, elevenlabs: false, video: false });
});

it("offers the server's image models, else Google's two", () => {
    const server = [
        { id: 'gemini-3.1-flash-image-preview', label: 'Flash Image (Fast)' },
        { id: 'azure/img', label: 'gpt-image-1.5 (img)' },
    ];
    expect(imageModelOptions(server)).toEqual([
        { name: 'Flash Image (Fast)', value: 'gemini-3.1-flash-image-preview' },
        { name: 'gpt-image-1.5 (img)', value: 'azure/img' },
    ]);
    expect(imageModelOptions([{ id: 'azure/bare', label: '' }])).toEqual([{ name: 'azure/bare', value: 'azure/bare' }]);
    expect(imageModelOptions(null)).toBe(IMAGE_MODELS);
    expect(imageModelOptions([])).toBe(IMAGE_MODELS);
});
