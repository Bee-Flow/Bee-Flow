// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { describePrivacyLine, findTurnTokenMap, messageTextOf } from './privacyLine';

/**
 * C7 — de privacyregel onder het bericht.
 *
 * De eigenschap die hier vastligt is niet "welke zin er staat" maar WANNEER het
 * scherm een vervanging mag aanwijzen. Een demonstratie ("vervangen door
 * [email_1] — de echte waarde bleef hier") is bewijs; hetzelfde zinnetje zonder
 * meting eronder is een privacyclaim waar iemand een beslissing op baseert.
 *
 * Daarom staat de degradatie hier net zo hard gepind als de demonstratie: als
 * de tokenmap ontbreekt of niets in dít bericht raakt, mag er géén
 * plaatsvervanger uit komen. Het onbekende moet versmallen, niet verdwijnen
 * achter een geruststellende teller.
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
        // DE KERN. De kluismap is conversatiebreed: twee waarden staan hier
        // woordelijk, de server verving er één. Welke van de twee weet dit
        // scherm niet. Er één aanwijzen is niet "de beste gok tonen" — de
        // lezer concludeert dan dat de ándere in het klaar naar buiten ging.
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
        // Beurt 3 typt een adres uit beurt 1 opnieuw. De kluis kent het token
        // nog, maar de vier vervangingen van deze beurt zaten in de BIJLAGE
        // (attachmentIntake.js telt `aggCount` over de bijlagen en geeft de
        // hele kluis als map mee). "4 gegevens vervangen, waaronder [email_1]"
        // maakt dat token dan lid van een verzameling waar het niet in zit.
        const line = describePrivacyLine({
            count: 4,
            messageText: 'jan@example.com staat in de bijlage, kun je de offerte nakijken?',
            tokenMap: { '[email_1]': 'jan@example.com' },
        });
        expect(line.form).toBe('demonstrated');
        expect(line.partial).toBe(true);
        // De beschrijving mag het token noemen; wat er NIET mag is het als
        // lid van de telling presenteren. Die zin staat in PrivacyLine.jsx en
        // wordt daar getest — hier pinnen we dat `partial` de vlag is die die
        // andere zin afdwingt.
        expect(line.shown).toBe(1);
        expect(line.count).toBe(4);
    });
});

describe('describePrivacyLine — een half gecontroleerde beurt', () => {
    it('draagt de doorlaat mee in de beschrijving', () => {
        // Onder fail_open ging het ongecontroleerde deel ONGEREDIGEERD naar de
        // AI. De telling is dan een ondergrens, geen samenvatting, en de zin
        // erboven mag dat niet verzwijgen.
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
        // De map bestaat, maar deze waarde komt uit een eerdere beurt. Hem hier
        // tonen zou een vervanging aanwijzen die in dit bericht niet gebeurde.
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
        // Staat de plaatsvervanger zelf in de tekst, dan bleef de echte waarde
        // hier juist NIET staan — dus is er niets te demonstreren.
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
