/**
 * The welcome headings, ported from the web.
 *
 * Pinned because the value of this file is that it is a COPY: the moment the
 * phone's list diverges from agent-hub/src/utils/prompts.js, the two clients
 * start speaking with two voices and translating the same idea twice.
 */

import { WELCOME_MESSAGES, pickWelcome } from './prompts';

describe('the ported welcome headings', () => {
    it("carries the web's i18n keys, which is the whole point of copying them", () => {
        for (const w of WELCOME_MESSAGES) expect(w.i18nKey).toMatch(/^starter\.welcome_\d+$/);
    });

    it("still contains the heading from the owner's screenshot", () => {
        // starter.welcome_5 renders as "Waar werken we aan?" in Dutch.
        expect(WELCOME_MESSAGES).toContainEqual({
            text: 'What are we working on?',
            i18nKey: 'starter.welcome_5',
        });
    });

    it('has no duplicate keys', () => {
        const keys = WELCOME_MESSAGES.map((w) => w.i18nKey);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('picking', () => {
    it('always returns a heading', () => {
        for (let i = 0; i < 50; i++) {
            expect(pickWelcome().text.length).toBeGreaterThan(0);
        }
    });
});
