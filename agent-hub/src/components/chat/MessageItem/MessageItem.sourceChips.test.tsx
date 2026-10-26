import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import { citationIsOpenable } from './answerChips';
import MessageItem from './index';
import type { ComponentProps } from 'react';
import { stub } from '@/test/mocks';

/**
 * The source chips under an answer (C6), and where they go (C13).
 *
 * ── WHAT IS FIXED HERE ─────────────────────────────────────────────────────
 *
 * 1. In an ORDINARY conversation the source stands under the answer, not behind two clicks to expand. A citation
 *    that you have to search for is not a citation.
 * 2. The same gate as the sources panel: on the public embed there is nothing. The chip row may not be a second,
 *    ungated path to the same data.
 * 3. A chip opens the passage, without the caller having to do anything for it.
 * 4. And a chip with nothing to open IS NOT A BUTTON. "Not sent along" and "may not read it" cannot be told
 *    apart from this side, so unknown readability narrows to non-clickable.
 *
 * It is tested on the property, not on the layout: which chip is clickable, what there is to read after a click,
 * and what is not shown when the gate is closed.
 */

/** A passage that came along completely. Here something can be opened. */
const OPEN_SOURCE = {
    title: 'Personeelshandboek',
    kind: 'kb_chunk',
    page: 12,
    section: '4.2 Bijzonder verlof',
    content: 'Bij een huwelijk krijg je twee dagen vrij.',
};

/**
 * A citation WITHOUT a passage. This really exists: `routes/ai/webpageChat.js` sends only `preview`, and a
 * server can omit the text because this reader may not read the source. The chip does not know the difference.
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

/** The overlay that a chip opens, or null if none is open. */
const overlay = () => document.querySelector('.fixed.inset-0');

describe('C6 — de bron staat onder het antwoord', () => {
    it('toont de chip in een gewoon gesprek, zonder dat de aanroeper erom vraagt', () => {
        // DirectChatView and AgentChatView pass no chip prop at all. If this depended on a prop, nobody in the product
        // would ever see a source chip.
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [OPEN_SOURCE] }))} />);
        expect(screen.getByTestId('citation-chip').textContent).toBe('Personeelshandboek · p. 12');
    });

    it('BIJT — maar niet als de bronnenpoort dicht is', () => {
        // De publieke embed (`embedSourcesAllowed`) zet hem dicht. Zou de rij
        // daarbuiten vallen, dan stond de documenttitel één regel boven de weg
        // die wél gepoort is.
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [OPEN_SOURCE] }))} showSources={false} />);
        expect(screen.queryByTestId('citation-chip')).toBeNull();
        expect(screen.queryByTestId('citation-chip-closed')).toBeNull();
        expect(screen.queryByText(/Personeelshandboek/)).toBeNull();
    });

    it('BIJT — en staat er niet terwijl het antwoord nog geschreven wordt', () => {
        // Citations land IN THE MIDDLE of the turn. Without this clamp, the row "where this answer comes from" grew
        // along while the answer did not yet exist, and the text beneath it jumped with each new chip.
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [OPEN_SOURCE], isStreaming: true }))} />);
        expect(screen.queryByTestId('citation-chip')).toBeNull();
        expect(screen.queryByTestId('answer-chips')).toBeNull();
    });

    it('BIJT — Simple Mode klapt de bron niet weg', () => {
        // Simple Mode removes the EXPANDABLE accountability ("How I got this answer"). The chip row is precisely the
        // simple form of that same information (one line, no machinery), and is therefore exactly what a user in
        // that mode should keep seeing.
        window.__beeflowSimpleMode = true;
        try {
            render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [OPEN_SOURCE] }))} />);
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
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(withRule)} allMessages={stub<ComponentProps<typeof MessageItem>['allMessages']>([withRule])} />);
        expect(screen.getByTestId('citation-chip')).toBeTruthy();
        expect(screen.queryByTestId('rule-chip')).toBeNull();
        expect(screen.queryByTestId('judged-label')).toBeNull();
    });
});

describe('C13 — de chip opent de passage', () => {
    it('opent de overlay met de tekst waar het antwoord op steunt', async () => {
        const user = userEvent.setup();
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [OPEN_SOURCE] }))} />);
        expect(overlay()).toBeNull();

        await user.click(screen.getByTestId('citation-chip'));

        expect(overlay()).toBeTruthy();
        expect(overlay()!.textContent).toContain('Bij een huwelijk krijg je twee dagen vrij.');
    });

    it('en gaat weer dicht', async () => {
        const user = userEvent.setup();
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [OPEN_SOURCE] }))} />);
        await user.click(screen.getByTestId('citation-chip'));
        // Name stands apart: the overlay borrows `notebooks.close`, and that key says "Close Notebook" in the
        // dictionary (see the note at this stage).
        await user.click(screen.getAllByRole('button', { name: /close/i })[0]);
        expect(overlay()).toBeNull();
    });

    it('BIJT — een aanroeper met een eigen bestemming houdt die', async () => {
        const user = userEvent.setup();
        // De notebooks vangen de klik zelf op en zetten de passage in hun
        // eigen paneel. Twee overlays over elkaar is geen bestemming.
        const onCitationClick = vi.fn();
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [OPEN_SOURCE] }))} onCitationClick={onCitationClick} />);

        await user.click(screen.getByTestId('citation-chip'));

        expect(onCitationClick).toHaveBeenCalledTimes(1);
        expect(onCitationClick.mock.calls[0][0].content).toBe(OPEN_SOURCE.content);
        expect(overlay()).toBeNull();
    });
});

describe('C13 — onbekende leesbaarheid versmalt naar niet-klikbaar', () => {
    it('BIJT — een citaat zonder passage is geen knop', () => {
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [CLOSED_SOURCE] }))} />);

        const chip = screen.getByTestId('citation-chip-closed');
        expect(chip.tagName).toBe('SPAN');
        expect(chip.closest('button')).toBeNull();
        // En hij komt niet óók als gewone, klikbare chip langs.
        expect(screen.queryByTestId('citation-chip')).toBeNull();
    });

    it('BIJT — klikken doet dan ook niets, in plaats van een leeg paneel', async () => {
        const user = userEvent.setup();
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [CLOSED_SOURCE] }))} />);
        await user.click(screen.getByTestId('citation-chip-closed'));
        expect(overlay()).toBeNull();
    });

    it('blijft wél staan: het antwoord heeft die bron gebruikt', () => {
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [CLOSED_SOURCE] }))} />);
        expect(screen.getByTestId('citation-chip-closed').textContent).toBe('Prijslijst · p. 3');
    });

    it('naast een bron die wél opengaat, en dan achteraan', () => {
        const { container } = render(
            <MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [CLOSED_SOURCE, OPEN_SOURCE] }))} />,
        );
        const chips = [...container.querySelectorAll(
            '[data-testid="citation-chip"],[data-testid="citation-chip-closed"]',
        )];
        expect(chips.map(c => c.getAttribute('data-testid')))
            .toEqual(['citation-chip', 'citation-chip-closed']);
    });

    it('BIJT — en de dichte chip valt achter dezelfde poort', () => {
        render(<MessageItem idx={0} msg={stub<ComponentProps<typeof MessageItem>['msg']>(msg({ kbSources: [CLOSED_SOURCE] }))} showSources={false} />);
        expect(screen.queryByTestId('citation-chip-closed')).toBeNull();
        expect(screen.queryByText(/Prijslijst/)).toBeNull();
    });
});

describe('citationIsOpenable', () => {
    it('opent alleen op een echte passage', () => {
        expect(citationIsOpenable({ content: 'Twee dagen vrij.' })).toBe(true);
    });

    it('BIJT — alles wat geen passage is, is geen toestemming', () => {
        // Also `preview`: that is the alias of one release, and the overlay does not read it. Approving it would yield
        // exactly the empty panel.
        for (const source of [
            undefined, null, {}, { content: '' }, { content: '   ' }, { content: null },
            { content: 42 }, { content: ['x'] }, { preview: 'Staffelkorting' },
            { title: 'Prijslijst', page: 3 },
        ]) {
            expect(citationIsOpenable(source), JSON.stringify(source)).toBe(false);
        }
    });
});
