/**
 * The words for what could not be read, and for counting what could: a
 * machine key the table does not know reads as itself, never as nothing,
 * and every countable kind has its singular and plural.
 */

import { translate } from '@/core/i18n';

import { byCount, countPhrase, COUNTED_SECTIONS, sectionNames } from './words';

describe('sectionNames', () => {
    it('names the sections the server reported, and passes an unknown one through as itself', () => {
        expect(sectionNames(['apps', 'automationExistence', 'all', 'runs', 'newThing', ''], translate)).toEqual([
            'apps',
            'the check on which automations still exist',
            'everything in this Solution',
            'how often things ran',
            'newThing',
        ]);
        expect(sectionNames(null, translate)).toEqual([]);
        expect(sectionNames(['toString'], translate)).toEqual(['toString']);
    });
});

describe('countPhrase', () => {
    it('counts every countable kind, one and many', () => {
        for (const { section } of COUNTED_SECTIONS) {
            expect(countPhrase(section, 1, translate)).toMatch(/^1 \S/);
            expect(countPhrase(section, 3, translate)).toMatch(/^3 .+s$/);
        }
        expect(countPhrase('automations', 1, translate)).toBe('1 automation');
        expect(countPhrase('approvals', 2, translate)).toBeNull();
    });

    it('picks the singular only for exactly one', () => {
        expect(byCount(1, 'one', 'many')).toBe('one');
        expect(byCount(0, 'one', 'many')).toBe('many');
    });
});
