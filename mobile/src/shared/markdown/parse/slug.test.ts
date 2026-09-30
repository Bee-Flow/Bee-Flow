/**
 * Heading anchors. The web keeps both rules inline in MarkdownRenderer.jsx's
 * JSX, so the lockstep is textual: the same replace chain, character for
 * character.
 */

import fs from 'node:fs';

import { AGENT_HUB_SRC } from '@/shared/testing/webModule';

import { anchorKey, findAnchor, headingSlug } from './slug';

const WEB = fs.readFileSync(`${AGENT_HUB_SRC}/components/renderers/MarkdownRenderer.jsx`, 'utf8');

describe('lockstep with the web', () => {
    it('slugs a heading with the web’s replace chain', () => {
        const chain = [
            ".toLowerCase()",
            ".replace(/[^\\p{L}\\p{N}\\s-]/gu, '')",
            ".replace(/\\s+/g, '-')",
            ".replace(/-+/g, '-')",
            ".replace(/^-|-$/g, '');",
        ];
        const compact = WEB.replace(/\s*\n\s*/g, '');
        expect(compact).toContain(chain.join(''));
    });

    it('matches fragments on the web’s [a-z0-9] key', () => {
        expect(WEB).toContain(".toLowerCase().replace(/[^a-z0-9]/g, '')");
    });
});

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
