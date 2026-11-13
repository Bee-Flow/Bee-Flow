/** The composer's slice of /ai/user-settings, from a new server and an older one. */

import { readComposerFlags } from './composerStatus';

it('reads the image models and whether image generation is configured', () => {
    const flags = readComposerFlags({
        hasGoogleKey: false,
        hasImageGen: true,
        imageModels: [{ id: 'azure/img', label: 'gpt-image-1.5 (img)', provider: 'azure' }, { label: 'no id' }, 'junk'],
    });
    expect(flags?.hasImageGen).toBe(true);
    expect(flags?.imageModels).toEqual([{ id: 'azure/img', label: 'gpt-image-1.5 (img)' }]);
});

it('leaves both unset when an older server does not send them', () => {
    const flags = readComposerFlags({ hasGoogleKey: true });
    expect(flags?.hasImageGen).toBeUndefined();
    expect(flags?.imageModels).toBeNull();
});
