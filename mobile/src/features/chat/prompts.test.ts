/**
 * The starter prompts, ported from the web.
 *
 * Pinned because the value of this file is that it is a COPY: the moment the
 * phone's list diverges from agent-hub/src/utils/prompts.js, the two clients
 * start speaking with two voices and translating the same idea twice.
 */

import { ALL_PROMPTS, WELCOME_MESSAGES, pickPrompts, pickWelcome } from './prompts';

describe('the ported prompt catalogue', () => {
    it('carries the web\'s i18n keys, which is the whole point of copying it', () => {
        // Without these the strings could not be translated, and a Dutch
        // account would read an English home screen under a Dutch web app.
        for (const p of ALL_PROMPTS) expect(p.i18nKey).toMatch(/^starter\.sp_\d+$/);
        for (const w of WELCOME_MESSAGES) expect(w.i18nKey).toMatch(/^starter\.welcome_\d+$/);
    });

    it('still contains the heading from the owner\'s screenshot', () => {
        // starter.welcome_5 renders as "Waar werken we aan?" in Dutch.
        expect(WELCOME_MESSAGES).toContainEqual({
            text: 'What are we working on?',
            i18nKey: 'starter.welcome_5',
        });
    });

    it('has no duplicate keys', () => {
        const keys = ALL_PROMPTS.map((p) => p.i18nKey);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('every prompt has an icon and text to fall back to', () => {
        for (const p of ALL_PROMPTS) {
            expect(p.text.length).toBeGreaterThan(0);
            expect(p.icon.length).toBeGreaterThan(0);
        }
    });
});

describe('picking', () => {
    it('returns the number asked for, without repeats', () => {
        for (let i = 0; i < 50; i++) {
            const picked = pickPrompts(3);
            expect(picked).toHaveLength(3);
            expect(new Set(picked.map((p) => p.i18nKey)).size).toBe(3);
        }
    });

    it('cannot ask for more than exist', () => {
        expect(pickPrompts(ALL_PROMPTS.length + 10)).toHaveLength(ALL_PROMPTS.length);
    });

    it('always returns a heading', () => {
        for (let i = 0; i < 50; i++) {
            expect(pickWelcome().text.length).toBeGreaterThan(0);
        }
    });
});
