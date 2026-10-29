import { render, screen } from '@testing-library/react';
import React, { type ComponentProps } from 'react';
import { describe, it, expect } from 'vitest';

import { interpolate } from '@/hooks/useTranslation';
import PrivacyLine from './PrivacyLine';

/**
 * C7: what the line says on screen, and above all what it does NOT say.
 *
 * The demonstration form may claim that the real value stayed here, because it points to the placeholder AND the
 * real value stands legibly in the bubble above it. The unproven form may not: nothing was measured there, and a
 * reassuring sentence without a measurement is worse than no sentence.
 *
 * `t` here is the real resolution form (the key is still missing from the dictionary, so the English fallback,
 * WITH interpolation), so that the test sees what a user sees today.
 */
type T = NonNullable<ComponentProps<typeof PrivacyLine>['t']>;
const t: T = (_key, fallback, params) => interpolate(fallback, params);

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
        // The artboard sets it in monospace on --bg-tertiary. More important is that it is an identifiable element and
        // does not disappear into the sentence.
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
        // The unknown narrows: not "3 items redacted", but precisely which piece of evidence the screen is missing.
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
        // A file broke off after 3 of 90 pages, and the rest went under fail_open UNREDACTED to the AI. "the real value
        // stayed here" is then true about what was shown and misleading about the rest. The sentence must carry the
        // pass-through itself, not only the pill beside it, because that is a second component with its own burden of proof.
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
        // The token vault is conversation-wide. With four replacements and one demonstrably present token, "4 replaced,
        // INCLUDING [email_1]" is a claim about membership that this screen cannot make. The two claims should stand
        // next to each other, not fused together.
        render(<PrivacyLine count={4} messageText={TEXT} tokenMap={MAP} t={t} />);

        expect(line()).toHaveAttribute('data-privacy-line', 'demonstrated');
        expect(screen.getByTestId('privacy-line-token')).toHaveTextContent('[email_1]');
        expect(line().textContent).not.toMatch(/among them/i);
        expect(line().textContent).toMatch(/4 values were replaced/i);
        expect(line().textContent).toMatch(/stands for a value in this message/i);
    });

    it('zegt het in enkelvoud waar er één vervanging was, ook onbewezen', () => {
        // The unproven form is the sentence that is read most often once an org does not share the token map. "1 values
        // were replaced" belongs there just as little as in the demonstration form.
        render(<PrivacyLine count={1} messageText={TEXT} tokenMap={null} t={t} />);

        expect(line()).toHaveAttribute('data-privacy-line', 'unproven');
        expect(line().textContent).toMatch(/1 value was replaced/i);
        expect(line().textContent).not.toMatch(/values were replaced/i);
        expect(line().textContent).toMatch(/which placeholder took its place/i);
        expect(line().textContent).not.toMatch(/placeholders took their place/i);
    });

    it('laat de plaatsvervanger nooit vallen, ook niet in een vertaling zonder {tokens}', () => {
        // The safety net that the code promises. A translator who removes the "odd brace" may not reduce the demonstration
        // to the counter form that this batch precisely removed. Then the chips end up at the back of the sentence.
        const noPlaceholder: T = (_key, _fallback, params) =>
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
