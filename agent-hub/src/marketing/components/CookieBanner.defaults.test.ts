// @vitest-environment node
/**
 * The cookie banner's seeded copy (server defaults, mirrored into the admin
 * editor) and the renderer's built-in fallback must say the same thing, and
 * must not claim that cookies are used: a site that never set analytics or
 * other cookies would otherwise show a false statement.
 */
import { describe, it, expect } from 'vitest';
import { SITE_DEFAULTS } from '../../components/admin/product-website/blockEditors/blockData.generated.mjs';
import { DEFAULT_TEXT } from './CookieBanner';

const seeded = SITE_DEFAULTS.cookieBanner.text;

describe('cookie banner default copy', () => {
    for (const lang of ['en', 'nl'] as const) {
        it(`${lang}: seed and renderer fallback agree`, () => {
            expect(DEFAULT_TEXT[lang].message).toBe(seeded[lang].message);
        });
    }

    it('makes no claim that cookies are used', () => {
        expect(seeded.en.message).not.toMatch(/we use cookies/i);
        expect(seeded.nl.message).not.toMatch(/gebruiken cookies/i);
    });
});
