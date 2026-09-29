import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';

import PrivacyLine from './PrivacyLine';
import { interpolate } from '../../../hooks/useTranslation';

/**
 * C7 — wat de regel op het scherm zegt, en vooral wat hij niet zegt.
 *
 * De demonstratievorm mag beweren dat de echte waarde hier bleef, want hij wijst
 * de plaatsvervanger aan én de echte waarde staat leesbaar in de bubbel erboven.
 * De onbewezen vorm mag dat niet: daar is niets gemeten, en een geruststellende
 * zin zonder meting is erger dan geen zin.
 *
 * `t` is hier de échte resolutie-vorm (sleutel ontbreekt nog in het woordenboek
 * → de Engelse fallback, mét interpolatie), zodat de test ziet wat een gebruiker
 * vandaag ziet.
 */
const t = (_key, fallback, params) => interpolate(fallback, params);

const TEXT = 'Bel Jan de Vries even op j.devries@vandijk.nl over de offerte.';
const MAP = { '[email_1]': 'j.devries@vandijk.nl' };

const line = () => screen.getByTestId('privacy-line');

describe('PrivacyLine — de demonstratievorm', () => {
    it('toont de plaatsvervanger die er daadwerkelijk voor in de plaats ging', () => {
        render(<PrivacyLine count={1} messageText={TEXT} tokenMap={MAP} t={t} />);

        expect(line()).toHaveAttribute('data-privacy-line', 'demonstrated');
        expect(screen.getByTestId('privacy-line-token')).toHaveTextContent('[email_1]');
        expect(line().textContent).toMatch(/the real value stayed here/i);
    });

    it('laat de plaatsvervanger als eigen element staan, niet als losse tekst', () => {
        // Het artboard zet hem in monospace op --bg-tertiary; belangrijker is dat
        // hij een aanwijsbaar element is en niet in de zin verdwijnt.
        render(<PrivacyLine count={1} messageText={TEXT} tokenMap={MAP} t={t} />);
        const token = screen.getByTestId('privacy-line-token');
        expect(token.tagName).toBe('CODE');
        expect(line().contains(token)).toBe(true);
    });

    it('laat geen onvervulde placeholder in de zin achter', () => {
        render(<PrivacyLine count={1} messageText={TEXT} tokenMap={MAP} t={t} />);
        expect(line().textContent).not.toMatch(/\{tokens\}|\{count\}/);
    });

    it('telt de vervangingen van de server, ook als het er meer zijn dan getoond', () => {
        render(
            <PrivacyLine
                count={5}
                messageText="aaa bbb ccc ddd eee"
                tokenMap={{ '[a_1]': 'aaa', '[b_1]': 'bbb', '[c_1]': 'ccc', '[d_1]': 'ddd', '[e_1]': 'eee' }}
                t={t}
            />,
        );
        expect(line().textContent).toMatch(/^\s*5 /);
        expect(screen.getAllByTestId('privacy-line-token')).toHaveLength(3);
        expect(line().textContent).not.toMatch(/\{tokens\}/);
    });
});

describe('PrivacyLine — de eerlijke degradatie', () => {
    it('doet zonder tokenmap geen enkele belofte over waar de echte waarde bleef', () => {
        render(<PrivacyLine count={1} messageText={TEXT} t={t} />);

        expect(line()).toHaveAttribute('data-privacy-line', 'unproven');
        expect(screen.queryByTestId('privacy-line-token')).toBeNull();
        expect(line().textContent).not.toMatch(/stayed here/i);
    });

    it('zegt wát er niet getoond kan worden, in plaats van alleen een aantal', () => {
        render(<PrivacyLine count={3} messageText={TEXT} t={t} />);
        // Het onbekende versmalt: niet "3 items redacted", maar precies welk
        // stuk bewijs het scherm mist.
        expect(line().textContent).toMatch(/cannot show which placeholder/i);
        expect(line().textContent).toMatch(/3/);
    });

    it('verzint geen plaatsvervanger uit een map van een ander bericht', () => {
        render(<PrivacyLine count={1} messageText={TEXT} tokenMap={{ '[email_2]': 'p.jansen@elders.nl' }} t={t} />);

        expect(line()).toHaveAttribute('data-privacy-line', 'unproven');
        expect(screen.queryByTestId('privacy-line-token')).toBeNull();
        expect(line().textContent).not.toMatch(/email_2/);
    });
});

describe('PrivacyLine — een half gecontroleerde beurt', () => {
    it('geruststelt niet dwars over een doorlaat heen', () => {
        // Een dossier brak na 3 van 90 pagina's af en de rest ging onder
        // fail_open ONGEREDIGEERD naar de AI. "de echte waarde bleef hier" is
        // dan waar over het aangetoonde en misleidend over de rest. De zin
        // moet de doorlaat zelf dragen — niet alleen de pil ernaast, want dat
        // is een tweede component met een eigen bewijslast.
        render(<PrivacyLine count={1} messageText={TEXT} tokenMap={MAP} scanIncomplete t={t} />);

        expect(screen.getByTestId('privacy-line-incomplete')).toBeTruthy();
        expect(line().textContent).toMatch(/could not be checked/i);
        expect(line().textContent).toMatch(/sent as it was/i);
    });

    it('draagt de doorlaat ook waar er niets aan te wijzen valt', () => {
        render(<PrivacyLine count={2} messageText={TEXT} tokenMap={null} scanIncomplete t={t} />);

        expect(line()).toHaveAttribute('data-privacy-line', 'unproven');
        expect(line().textContent).toMatch(/could not be checked/i);
    });

    it('zegt niets over een doorlaat waar de controle wél rond kwam', () => {
        render(<PrivacyLine count={1} messageText={TEXT} tokenMap={MAP} t={t} />);

        expect(screen.queryByTestId('privacy-line-incomplete')).toBeNull();
        expect(line().textContent).not.toMatch(/could not be checked/i);
    });
});

describe('PrivacyLine — wat de zin niet mag claimen', () => {
    it('maakt de aangetoonde plaatsvervanger geen lid van de telling', () => {
        // De kluismap is conversatiebreed. Bij vier vervangingen en één
        // aantoonbaar token is "4 vervangen, WAARONDER [email_1]" een bewering
        // over lidmaatschap die dit scherm niet kan doen. De twee beweringen
        // horen naast elkaar te staan, niet in elkaar geschoven.
        render(<PrivacyLine count={4} messageText={TEXT} tokenMap={MAP} t={t} />);

        expect(line()).toHaveAttribute('data-privacy-line', 'demonstrated');
        expect(screen.getByTestId('privacy-line-token')).toHaveTextContent('[email_1]');
        expect(line().textContent).not.toMatch(/among them/i);
        expect(line().textContent).toMatch(/4 values were replaced/i);
        expect(line().textContent).toMatch(/stands for a value in this message/i);
    });

    it('zegt het in enkelvoud waar er één vervanging was, ook onbewezen', () => {
        // De onbewezen vorm is de zin die het meest gelezen wordt zodra een org
        // de tokenmap niet deelt; "1 values were replaced" hoort daar net zo
        // min als in de demonstratievorm.
        render(<PrivacyLine count={1} messageText={TEXT} tokenMap={null} t={t} />);

        expect(line()).toHaveAttribute('data-privacy-line', 'unproven');
        expect(line().textContent).toMatch(/1 value was replaced/i);
        expect(line().textContent).not.toMatch(/values were replaced/i);
        expect(line().textContent).toMatch(/which placeholder took its place/i);
        expect(line().textContent).not.toMatch(/placeholders took their place/i);
    });

    it('laat de plaatsvervanger nooit vallen, ook niet in een vertaling zonder {tokens}', () => {
        // Het vangnet dat de code belooft. Een vertaler die de "rare accolade"
        // weghaalt mag de demonstratie niet terugbrengen tot de tellervorm die
        // deze batch juist wegnam — dan komen de chips achteraan de zin.
        const noPlaceholder = (_key, _fallback, params) =>
            interpolate('Er zijn {count} gegevens vervangen voordat dit naar de AI ging.', params);
        render(<PrivacyLine count={1} messageText={TEXT} tokenMap={MAP} t={noPlaceholder} />);

        expect(screen.getByTestId('privacy-line-token')).toHaveTextContent('[email_1]');
        expect(line().textContent).toMatch(/\[email_1\]/);
    });

    it('zet geen letterlijke {count} op het scherm zonder een t van de aanroeper', () => {
        // De reserve-`t` moet interpoleren: dezelfde fout is in TokenisedBadge
        // al eens gemaakt en gedicht.
        render(<PrivacyLine count={3} messageText={TEXT} tokenMap={null} />);

        expect(line().textContent).not.toMatch(/\{count\}/);
        expect(line().textContent).toMatch(/3 values were replaced/i);
    });
});

describe('PrivacyLine — niets te melden', () => {
    it('rendert niets zonder vervangingen', () => {
        const { container } = render(<PrivacyLine count={0} messageText={TEXT} tokenMap={MAP} t={t} />);
        expect(container.firstChild).toBeNull();
        expect(screen.queryByTestId('privacy-line')).toBeNull();
    });
});
