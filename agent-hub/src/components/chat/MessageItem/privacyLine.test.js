// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { describePrivacyLine, findTurnTokenMap, messageTextOf } from './privacyLine';

/**
 * C7: the privacy line under the message.
 *
 * The property pinned here is not "which sentence is shown" but WHEN the screen
 * may point to a substitution. A demonstration ("replaced by [email_1]: the real
 * value stayed here") is evidence. The same little sentence without a measurement
 * underneath is a privacy claim that someone bases a decision on.
 *
 * That is why the downgrade is pinned here just as hard as the demonstration: if
 * the token map is missing, or nothing in THIS message touches it, no stand-in
 * may come out. The unknown must narrow, not vanish behind a reassuring counter.
 */

const TEXT = 'Bel Jan de Vries even op j.devries@vandijk.nl over de offerte.';

describe('describePrivacyLine — er valt niets te melden', () => {
    it('zwijgt zonder telling', () => {
        expect(describePrivacyLine({ count: 0, messageText: TEXT, tokenMap: { '[email_1]': 'j.devries@vandijk.nl' } })).toBeNull();
        expect(describePrivacyLine({ messageText: TEXT })).toBeNull();
        expect(describePrivacyLine()).toBeNull();
    });
});

describe('describePrivacyLine — de demonstratievorm', () => {
    it('wijst de plaatsvervanger aan waarvan de echte waarde in dit bericht staat', () => {
        const line = describePrivacyLine({
            count: 1,
            messageText: TEXT,
            tokenMap: { '[email_1]': 'j.devries@vandijk.nl' },
        });
        expect(line.form).toBe('demonstrated');
        expect(line.tokens).toEqual(['[email_1]']);
        expect(line.partial).toBe(false);
    });

    it('zet de plaatsvervangers in leesvolgorde van het bericht', () => {
        const line = describePrivacyLine({
            count: 2,
            messageText: TEXT,
            tokenMap: { '[email_1]': 'j.devries@vandijk.nl', '[person_1]': 'Jan de Vries' },
        });
        // "Jan de Vries" staat vóór het e-mailadres; de regel volgt de bubbel.
        expect(line.tokens).toEqual(['[person_1]', '[email_1]']);
        expect(line.partial).toBe(false);
    });

    it('toont er hooguit een handvol en zegt dan dat het er meer waren', () => {
        const line = describePrivacyLine({
            count: 5,
            messageText: 'aaa bbb ccc ddd eee',
            tokenMap: { '[a_1]': 'aaa', '[b_1]': 'bbb', '[c_1]': 'ccc', '[d_1]': 'ddd', '[e_1]': 'eee' },
        });
        expect(line.form).toBe('demonstrated');
        expect(line.tokens).toHaveLength(3);
        expect(line.count).toBe(5);
        expect(line.partial).toBe(true);
    });

    it('belooft nooit meer plaatsvervangers dan de server vervangingen telde', () => {
        const line = describePrivacyLine({
            count: 2,
            messageText: 'aaa bbb ccc',
            tokenMap: { '[a_1]': 'aaa', '[b_1]': 'bbb' },
        });
        expect(line.shown).toBeLessThanOrEqual(line.count);
        expect(line.tokens).toEqual(['[a_1]', '[b_1]']);
    });

    it('wijst niets aan zodra er meer kandidaten zijn dan vervangingen', () => {
        // THE CORE. The vault map is conversation-wide: two values stand here
        // literally, and the server replaced one. Which of the two this screen does
        // not know. Pointing at one is not "showing the best guess". The reader then
        // concludes that the OTHER one went out in the clear.
        const line = describePrivacyLine({
            count: 1,
            messageText: 'Niet jan@example.com maar piet@example.com gebruiken.',
            tokenMap: { '[email_1]': 'jan@example.com', '[email_2]': 'piet@example.com' },
        });
        expect(line.form).toBe('unproven');
        expect(line.tokens).toEqual([]);
        expect(line.count).toBe(1);
    });

    it('schrijft een oude kluiswaarde niet toe aan deze beurt', () => {
        // Turn 3 types an address from turn 1 again. The vault still knows the token,
        // but the four replacements of this turn were in the ATTACHMENT
        // (attachmentIntake.js counts `aggCount` over the attachments and passes the
        // whole vault along as a map). "4 data replaced, including [email_1]" would
        // then make that token a member of a collection it is not in.
        const line = describePrivacyLine({
            count: 4,
            messageText: 'jan@example.com staat in de bijlage, kun je de offerte nakijken?',
            tokenMap: { '[email_1]': 'jan@example.com' },
        });
        expect(line.form).toBe('demonstrated');
        expect(line.partial).toBe(true);
        // The description may name the token. What may NOT happen is presenting it
        // as a member of the count. That sentence is in PrivacyLine.jsx and is tested
        // there. Here we pin that `partial` is the flag that the other sentence enforces.
        expect(line.shown).toBe(1);
        expect(line.count).toBe(4);
    });
});

describe('describePrivacyLine — een half gecontroleerde beurt', () => {
    it('draagt de doorlaat mee in de beschrijving', () => {
        // Under fail_open the unchecked part went to the AI UNREDACTED. The count is
        // then a lower bound, not a summary, and the sentence above may not conceal that.
        const line = describePrivacyLine({
            count: 1,
            messageText: 'j.devries@vandijk.nl',
            tokenMap: { '[email_1]': 'j.devries@vandijk.nl' },
            scanIncomplete: true,
        });
        expect(line.form).toBe('demonstrated');
        expect(line.incomplete).toBe(true);
    });

    it('meldt een volledige controle niet als onvolledig', () => {
        const line = describePrivacyLine({
            count: 1,
            messageText: 'j.devries@vandijk.nl',
            tokenMap: { '[email_1]': 'j.devries@vandijk.nl' },
        });
        expect(line.incomplete).toBe(false);
    });

    it('draagt de doorlaat ook mee waar er niets aan te wijzen valt', () => {
        const line = describePrivacyLine({ count: 2, messageText: 'niets', scanIncomplete: true });
        expect(line.form).toBe('unproven');
        expect(line.incomplete).toBe(true);
    });
});

describe('describePrivacyLine — de eerlijke degradatie', () => {
    it('wijst niets aan zonder tokenmap', () => {
        const line = describePrivacyLine({ count: 1, messageText: TEXT });
        expect(line.form).toBe('unproven');
        expect(line.tokens).toEqual([]);
        expect(line.count).toBe(1);
    });

    it('wijst niets aan bij een lege of kapotte map', () => {
        expect(describePrivacyLine({ count: 2, messageText: TEXT, tokenMap: {} }).form).toBe('unproven');
        expect(describePrivacyLine({ count: 2, messageText: TEXT, tokenMap: 'nope' }).form).toBe('unproven');
        expect(describePrivacyLine({ count: 2, messageText: TEXT, tokenMap: { '[email_1]': null } }).form).toBe('unproven');
    });

    it('leent geen bewijs van een ander bericht', () => {
        // The map exists, but this value comes from an earlier turn. Showing it here
        // would point to a replacement that did not happen in this message.
        const line = describePrivacyLine({
            count: 1,
            messageText: TEXT,
            tokenMap: { '[email_2]': 'p.jansen@elders.nl' },
        });
        expect(line.form).toBe('unproven');
        expect(line.tokens).toEqual([]);
    });

    it('hangt een demonstratie niet op aan een toevallige korte match', () => {
        const line = describePrivacyLine({
            count: 1,
            messageText: 'De offerte van NL naar BE.',
            tokenMap: { '[country_1]': 'NL' },
        });
        expect(line.form).toBe('unproven');
    });

    it('degradeert ook wanneer het bericht alleen nog de tokens draagt', () => {
        // If the stand-in itself is in the text, then the real value did NOT stay here,
        // so there is nothing to demonstrate.
        const line = describePrivacyLine({
            count: 1,
            messageText: 'Bel [person_1] even op [email_1] over de offerte.',
            tokenMap: { '[email_1]': 'j.devries@vandijk.nl', '[person_1]': 'Jan de Vries' },
        });
        expect(line.form).toBe('unproven');
    });
});

describe('findTurnTokenMap — welke map bij dit bericht hoort', () => {
    const withMap = (map) => ({ role: 'assistant', tokenisationInfo: { tokenMap: map } });

    it('pakt de map van het antwoord op dit bericht', () => {
        const messages = [{ role: 'user' }, withMap({ '[email_1]': 'a@b.nl' })];
        expect(findTurnTokenMap(messages, 0)).toEqual({ '[email_1]': 'a@b.nl' });
    });

    it('kijkt niet voorbij het volgende gebruikersbericht', () => {
        const messages = [
            { role: 'user' },
            { role: 'assistant' },
            { role: 'user' },
            withMap({ '[email_9]': 'later@b.nl' }),
        ];
        expect(findTurnTokenMap(messages, 0)).toBeNull();
    });

    it('overleeft een lege lijst, gaten en een ontbrekende map', () => {
        expect(findTurnTokenMap([], 0)).toBeNull();
        expect(findTurnTokenMap(null, 0)).toBeNull();
        expect(findTurnTokenMap([{ role: 'user' }, null, { role: 'assistant' }], 0)).toBeNull();
        expect(findTurnTokenMap([{ role: 'user' }, withMap({})], 0)).toBeNull();
    });
});

describe('messageTextOf', () => {
    it('leest een gewone string', () => {
        expect(messageTextOf({ content: TEXT })).toBe(TEXT);
    });

    it('leest de tekstdelen van een samengesteld bericht', () => {
        const msg = { content: [{ type: 'image', url: 'x' }, { type: 'text', text: TEXT }] };
        expect(messageTextOf(msg)).toBe(TEXT);
    });

    it('geeft een lege string terug waar er geen tekst is', () => {
        expect(messageTextOf({})).toBe('');
        expect(messageTextOf(null)).toBe('');
    });
});
