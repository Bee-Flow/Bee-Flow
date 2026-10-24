/**
 * Heading anchors. headingSlug and anchorKey are the web's own functions
 * (generated copy of agent-hub's markdownRules.ts, under ../mirror), so only
 * their behaviour is tested here.
 */

import { anchorKey, findAnchor, headingSlug } from './slug';

describe('headingSlug', () => {
    it('keeps letters in any script and joins words with hyphens', () => {
        expect(headingSlug('Step 2: Installing — the CLI!')).toBe('step-2-installing-the-cli');
        expect(headingSlug('Überblick & Zusammenfassung')).toBe('überblick-zusammenfassung');
        expect(headingSlug('  --Edge--  ')).toBe('edge');
    });
});

describe('findAnchor', () => {
    const headings = [
        { slug: 'overview', text: 'Overview' },
        { slug: 'step-2-installing', text: 'Step 2: Installing' },
    ];

    it('prefers the exact slug', () => {
        expect(findAnchor('#overview', headings)?.text).toBe('Overview');
    });

    it('falls back to the fuzzy match, both ways round', () => {
        expect(findAnchor('#step-2-install', headings)?.text).toBe('Step 2: Installing');
        expect(findAnchor('#step2installingthetools', headings)?.text).toBe('Step 2: Installing');
    });

    it('finds nothing for an empty or unknown fragment', () => {
        expect(findAnchor('#', headings)).toBeUndefined();
        expect(findAnchor('#pricing', headings)).toBeUndefined();
    });

    it('keys on ASCII letters and digits only', () => {
        expect(anchorKey('Ab-1 é')).toBe('ab1');
    });
});
