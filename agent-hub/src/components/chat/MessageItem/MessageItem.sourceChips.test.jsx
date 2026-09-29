import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import { citationIsOpenable } from './answerChips';
import MessageItem from './index';

/**
 * De bronchips onder een antwoord (C6), en waar ze heen gaan (C13).
 *
 * ── WAT HIER VASTLIGT ──────────────────────────────────────────────────────
 *
 * 1. In een GEWOON gesprek staat de bron onder het antwoord, niet achter twee
 *    keer uitklappen. Een citaat dat je moet zoeken is geen citaat.
 * 2. Dezelfde poort als het bronnenpaneel: op de publieke embed staat er niets.
 *    De chiprij mag geen tweede, ongepoorte weg naar dezelfde gegevens zijn.
 * 3. Een chip opent de passage — zonder dat de aanroeper daar iets voor doet.
 * 4. En een chip die niets te openen heeft, IS GEEN KNOP. "Niet meegestuurd"
 *    en "mag je niet lezen" zijn van deze kant niet te onderscheiden, dus
 *    versmalt onbekende leesbaarheid naar niet-klikbaar.
 *
 * Er wordt op de eigenschap getest, niet op de opmaak: welke chip klikbaar is,
 * wat er na een klik te lezen valt, en wat er bij een dichte poort niet staat.
 */

/** Een passage die volledig meekwam — hier valt iets te openen. */
const OPEN_SOURCE = {
    title: 'Personeelshandboek',
    kind: 'kb_chunk',
    page: 12,
    section: '4.2 Bijzonder verlof',
    content: 'Bij een huwelijk krijg je twee dagen vrij.',
};

/**
 * Een citaat ZONDER passage. Bestaat echt: `routes/ai/webpageChat.js` stuurt
 * alleen `preview`, en een server kan de tekst weglaten omdat deze lezer de
 * bron niet mag lezen. De chip weet het verschil niet.
 */
const CLOSED_SOURCE = {
    title: 'Prijslijst',
    kind: 'kb_chunk',
    page: 3,
    preview: 'Staffelkorting vanaf 100 stuks',
};

const msg = (over = {}) => ({
    id: 'm-1',
    role: 'assistant',
    content: 'Dat regelt het handboek.',
    modelId: null,
    ...over,
});

/** De overlay die een chip opent — of null als er geen openstaat. */
const overlay = () => document.querySelector('.fixed.inset-0');

describe('C6 — de bron staat onder het antwoord', () => {
    it('toont de chip in een gewoon gesprek, zonder dat de aanroeper erom vraagt', () => {
        // DirectChatView en AgentChatView geven geen enkele chip-prop mee; als
        // dit van een prop zou afhangen, zag niemand in het product ooit een
        // bronchip.
        render(<MessageItem idx={0} msg={msg({ kbSources: [OPEN_SOURCE] })} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Personeelshandboek · p. 12');
    });

    it('BIJT — maar niet als de bronnenpoort dicht is', () => {
        // De publieke embed (`embedSourcesAllowed`) zet hem dicht. Zou de rij
        // daarbuiten vallen, dan stond de documenttitel één regel boven de weg
        // die wél gepoort is.
        render(<MessageItem idx={0} msg={msg({ kbSources: [OPEN_SOURCE] })} showSources={false} />);
        expect(screen.queryByTestId('citation-chip')).toBeNull();
        expect(screen.queryByTestId('citation-chip-closed')).toBeNull();
        expect(screen.queryByText(/Personeelshandboek/)).toBeNull();
    });

    it('BIJT — en staat er niet terwijl het antwoord nog geschreven wordt', () => {
        // Citaten landen MIDDEN in de beurt. Zonder deze klem groeide de rij
        // "waar dit antwoord vandaan komt" mee terwijl het antwoord nog niet
        // bestond, en sprong de tekst eronder bij elke nieuwe chip op.
        render(<MessageItem idx={0} msg={msg({ kbSources: [OPEN_SOURCE], isStreaming: true })} />);
        expect(screen.queryByTestId('citation-chip')).toBeNull();
        expect(screen.queryByTestId('answer-chips')).toBeNull();
    });

    it('BIJT — Simple Mode klapt de bron niet weg', () => {
        // Simple Mode haalt de UITKLAPBARE verantwoording weg ("How I got this
        // answer"). De chiprij is juist de simpele vorm van diezelfde
        // informatie — één regel, geen machinerie — en is dus precies wat een
        // gebruiker in die modus wél hoort te houden.
        window.__beeflowSimpleMode = true;
        try {
            render(<MessageItem idx={0} msg={msg({ kbSources: [OPEN_SOURCE] })} />);
            expect(screen.getByTestId('citation-chip').textContent).toBe('Personeelshandboek · p. 12');
            expect(screen.queryByText(/How I got this answer/)).toBeNull();
        } finally {
            delete window.__beeflowSimpleMode;
        }
    });

    it('BIJT — de verantwoordingshelft komt er niet mee mee', () => {
        // C6 opent de bronchips voor iedereen; de skills en de geoordeelde
        // regel blijven de bouwersweergave uit A4.
        const withRule = msg({
            kbSources: [OPEN_SOURCE],
            ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] },
        });
        render(<MessageItem idx={0} msg={withRule} allMessages={[withRule]} />);
        expect(screen.getByTestId('citation-chip')).toBeTruthy();
        expect(screen.queryByTestId('rule-chip')).toBeNull();
        expect(screen.queryByTestId('judged-label')).toBeNull();
    });
});

describe('C13 — de chip opent de passage', () => {
    it('opent de overlay met de tekst waar het antwoord op steunt', () => {
        render(<MessageItem idx={0} msg={msg({ kbSources: [OPEN_SOURCE] })} />);
        expect(overlay()).toBeNull();

        fireEvent.click(screen.getByTestId('citation-chip'));

        expect(overlay()).toBeTruthy();
        expect(overlay().textContent).toContain('Bij een huwelijk krijg je twee dagen vrij.');
    });

    it('en gaat weer dicht', () => {
        render(<MessageItem idx={0} msg={msg({ kbSources: [OPEN_SOURCE] })} />);
        fireEvent.click(screen.getByTestId('citation-chip'));
        // Naam los: de overlay leent `notebooks.close`, en die sleutel zegt in
        // het woordenboek "Close Notebook" (zie de melding bij deze stage).
        fireEvent.click(screen.getAllByRole('button', { name: /close/i })[0]);
        expect(overlay()).toBeNull();
    });

    it('BIJT — een aanroeper met een eigen bestemming houdt die', () => {
        // De notebooks vangen de klik zelf op en zetten de passage in hun
        // eigen paneel. Twee overlays over elkaar is geen bestemming.
        const onCitationClick = vi.fn();
        render(<MessageItem idx={0} msg={msg({ kbSources: [OPEN_SOURCE] })} onCitationClick={onCitationClick} />);

        fireEvent.click(screen.getByTestId('citation-chip'));

        expect(onCitationClick).toHaveBeenCalledTimes(1);
        expect(onCitationClick.mock.calls[0][0].content).toBe(OPEN_SOURCE.content);
        expect(overlay()).toBeNull();
    });
});

describe('C13 — onbekende leesbaarheid versmalt naar niet-klikbaar', () => {
    it('BIJT — een citaat zonder passage is geen knop', () => {
        render(<MessageItem idx={0} msg={msg({ kbSources: [CLOSED_SOURCE] })} />);

        const chip = screen.getByTestId('citation-chip-closed');
        expect(chip.tagName).toBe('SPAN');
        expect(chip.closest('button')).toBeNull();
        // En hij komt niet óók als gewone, klikbare chip langs.
        expect(screen.queryByTestId('citation-chip')).toBeNull();
    });

    it('BIJT — klikken doet dan ook niets, in plaats van een leeg paneel', () => {
        render(<MessageItem idx={0} msg={msg({ kbSources: [CLOSED_SOURCE] })} />);
        fireEvent.click(screen.getByTestId('citation-chip-closed'));
        expect(overlay()).toBeNull();
    });

    it('blijft wél staan: het antwoord heeft die bron gebruikt', () => {
        render(<MessageItem idx={0} msg={msg({ kbSources: [CLOSED_SOURCE] })} />);
        expect(screen.getByTestId('citation-chip-closed').textContent).toBe('Prijslijst · p. 3');
    });

    it('naast een bron die wél opengaat, en dan achteraan', () => {
        const { container } = render(
            <MessageItem idx={0} msg={msg({ kbSources: [CLOSED_SOURCE, OPEN_SOURCE] })} />,
        );
        const chips = [...container.querySelectorAll(
            '[data-testid="citation-chip"],[data-testid="citation-chip-closed"]',
        )];
        expect(chips.map(c => c.getAttribute('data-testid')))
            .toEqual(['citation-chip', 'citation-chip-closed']);
    });

    it('BIJT — en de dichte chip valt achter dezelfde poort', () => {
        render(<MessageItem idx={0} msg={msg({ kbSources: [CLOSED_SOURCE] })} showSources={false} />);
        expect(screen.queryByTestId('citation-chip-closed')).toBeNull();
        expect(screen.queryByText(/Prijslijst/)).toBeNull();
    });
});

describe('citationIsOpenable', () => {
    it('opent alleen op een echte passage', () => {
        expect(citationIsOpenable({ content: 'Twee dagen vrij.' })).toBe(true);
    });

    it('BIJT — alles wat geen passage is, is geen toestemming', () => {
        // Ook `preview`: dat is de alias van één release, en de overlay leest
        // hem niet — goedkeuren zou precies het lege paneel opleveren.
        for (const source of [
            undefined, null, {}, { content: '' }, { content: '   ' }, { content: null },
            { content: 42 }, { content: ['x'] }, { preview: 'Staffelkorting' },
            { title: 'Prijslijst', page: 3 },
        ]) {
            expect(citationIsOpenable(source), JSON.stringify(source)).toBe(false);
        }
    });
});
