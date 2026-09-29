import { describe, expect, it } from 'vitest';

import type { CustomDataType } from './ownDataModel';
import { LIMITS } from './ownDataModel';
import { STARTERS, starterInit, starterPlaceholder } from './starters';
import { t } from './testKit';

/**
 * The starters only prefill the wizard. What a tile promises (its
 * placeholder) must be what the wizard then gives the type.
 */

const TAKEN: CustomDataType = {
    id: 'cdt_0000000009', name: 'Old', description: '', method: 'words', tokenKey: 'project_code', origin: 'created',
    words: { values: ['x'], caseSensitive: false, wholeWord: true },
};

describe('starterPlaceholder', () => {
    it('is the placeholder the wizard will give the starter', () => {
        expect(starterPlaceholder('projects', [], t)).toBe('[project_code_1]');
        expect(starterPlaceholder('numbers', [], t)).toBe('[customer_number_1]');
        expect(`[${starterInit('numbers', [], true, t).type.tokenKey}_1]`).toBe(starterPlaceholder('numbers', [], t));
    });

    it('moves on when the key is taken, like the wizard', () => {
        const shown = starterPlaceholder('projects', [TAKEN], t);
        expect(shown).not.toBe('[project_code_1]');
        expect(shown).toBe(`[${starterInit('projects', [TAKEN], true, t).type.tokenKey}_1]`);
    });

    it('has none for a starter that opens without a name', () => {
        expect(starterPlaceholder('words', [], t)).toBeNull();
        expect(starterPlaceholder('other', [], t)).toBeNull();
    });
});

describe('starterInit', () => {
    it('opens the open-ended starter blank, with the method still to choose', () => {
        const init = starterInit('other', [], true, t);
        expect(init).toMatchObject({ mode: 'new', methodChosen: false, apply: { detect: true, external: true, internal: false } });
        expect(init.type).toMatchObject({ name: '', description: '', tokenKey: '' });
    });

    it('puts the admin\'s own sentence in the description, clipped to what the wizard accepts', () => {
        expect(starterInit('other', [], true, t, '  Our claim numbers start with SD-  ').type.description).toBe('Our claim numbers start with SD-');
        expect(starterInit('other', [], true, t, 'x'.repeat(LIMITS.description + 50)).type.description).toHaveLength(LIMITS.description);
        // Blank input keeps the starter's own description.
        expect(starterInit('numbers', [], true, t, '   ').type.description).toBe('Our customer numbers. They always have the same format.');
    });

    it('never offers outside tools without the tool guard', () => {
        expect(starterInit('numbers', [], false, t).apply.external).toBe(false);
    });

    it('draws only the open-ended starter as open', () => {
        expect(STARTERS.filter(s => s.open).map(s => s.id)).toEqual(['other']);
        expect(STARTERS.map(s => s.method)).toEqual(['ai', 'pattern', 'words', null]);
    });
});
