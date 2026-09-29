import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';

import AnswerTracePanel from './AnswerTracePanel';

/**
 * Het spoorpaneel op het scherm. Drie dingen die er echt toe doen:
 *
 *   1. EEN ONTBREKENDE STAP IS ZICHTBAAR. Het paneel toont altijd vijf regels;
 *      een regel zonder event staat er met de reden erbij en zonder één feit.
 *      Alleen de geslaagde stappen tonen leest als een compleet verhaal, en
 *      dan is "niet gemeten" niet te onderscheiden van "niet gebeurd".
 *   2. GEOORDEELD ZIET ER ANDERS UIT DAN OPGETEKEND. Dezelfde dragers als de
 *      chiprij: eigen vorm, eigen kopje, de uitleg als toegankelijke naam.
 *   3. EEN BESLISSING DIE ALSNOG VALT, WERKT DE REGEL BIJ — en zegt daarbij
 *      het verschil tussen "heeft gedraaid" en "gaat draaien".
 */

const KEY = 'a'.repeat(32);

const step = (stage, over = {}) => ({
    stage, detail: null, startedAt: 1000, endedAt: 1100, durationMs: 100, ...over,
});

const fullTurn = () => ({
    id: 'm-1',
    role: 'assistant',
    content: 'Dat kan. Ik heb het opgezocht.',
    phaseTrail: [
        step('processed_history', { startedAt: 1000, endedAt: 1020, durationMs: 20 }),
        step('building_prompt', { startedAt: 1020, endedAt: 1060, durationMs: 40 }),
        step('kb_search', { startedAt: 1060, endedAt: 1260, durationMs: 200 }),
        // GEEN `endedAt`: `streaming_start` krijgt nergens een tegenhanger —
        // elke emitter is een kale `emitPhase(...)` en de `emitPhaseEnd`-lijst
        // kent die stage niet. Een fixture die er wél een geeft bevestigt een
        // vorm die niet bestaat.
        step('streaming_start', { detail: 'claude-opus-5', startedAt: 1300, endedAt: null, durationMs: null }),
    ],
    toolHistory: [{ name: 'kb_search', args: { query: 'verlofdagen' }, startTime: 1060, endTime: 1260, status: 'done' }],
    kbSources: [
        { title: 'Personeelshandboek', content: 'Twee dagen.' },
        { title: 'Verlofregeling', content: 'Maximaal 25 dagen.' },
    ],
    ruleAttribution: { rules: [{ rule: 'Nooit een prijs noemen' }] },
    pendingToolCalls: [{ callId: 'c1', toolName: 'gmail_compose', effect: 'sends', argsKey: KEY, status: 'pending' }],
});

const rowFor = (id) => document.querySelector(`[data-testid="trace-row"][data-row="${id}"]`);

describe('de vijf regels', () => {
    it('staan er altijd alle vijf, in leesvolgorde', () => {
        render(<AnswerTracePanel msg={fullTurn()} />);
        const rows = [...document.querySelectorAll('[data-testid="trace-row"]')];
        expect(rows.map(r => r.getAttribute('data-row')))
            .toEqual(['question', 'sources', 'rule', 'held_action', 'answer']);
    });

    it('tonen de gemeten feiten van de beurt', () => {
        render(<AnswerTracePanel msg={fullTurn()} />);
        expect(within(rowFor('sources')).getByTestId('trace-fact').textContent)
            .toBe('Searched for “verlofdagen” · 2 passages from 2 documents');
        expect(within(rowFor('answer')).getByTestId('trace-fact').textContent)
            .toBe('Written by claude-opus-5 · 2 sentences');
    });

    it('de kop draagt de spanwijdte van het spoor, niet de som van de duren', () => {
        render(<AnswerTracePanel msg={fullTurn()} />);
        // 1000 → 1300 = 300ms. De som van de duren zou 260ms zijn geweest.
        const pills = [...document.querySelectorAll('[data-testid="duration-pill"]')];
        expect(pills[0].textContent).toBe('300ms');
    });

    it('BIJT — en zegt dat de klok stopt waar het antwoord BEGINT', () => {
        // De laatste tik in een echt spoor is `streaming_start`, en die krijgt
        // geen einde. Dit getal is dus de voorbereidingstijd, niet de beurtduur
        // — een beurt van twintig seconden toont hier 300ms. Dat mag niet
        // verdwijnen in een algemene zin boven vijf regels die wél over het
        // antwoord gaan.
        render(<AnswerTracePanel msg={fullTurn()} />);
        const pill = document.querySelector('[data-testid="duration-pill"]');
        expect(pill.getAttribute('title'))
            .toBe('Time from the first recorded step until the answer started — the writing itself is not timed');
    });

    it('een spoor dat wél netjes afsluit krijgt de gewone zin', () => {
        const msg = fullTurn();
        msg.phaseTrail = msg.phaseTrail.filter(r => r.stage !== 'streaming_start');
        render(<AnswerTracePanel msg={msg} />);
        const pill = document.querySelector('[data-testid="duration-pill"]');
        expect(pill.getAttribute('title'))
            .toBe('Time between the first and the last recorded step');
    });

    it('enkelvoud is enkelvoud', () => {
        const msg = { ...fullTurn(), content: 'Klaar.', kbSources: [{ title: 'Handboek', content: 'x' }] };
        render(<AnswerTracePanel msg={msg} />);
        expect(within(rowFor('sources')).getByTestId('trace-fact').textContent)
            .toContain('1 passage from 1 document');
        expect(within(rowFor('answer')).getByTestId('trace-fact').textContent)
            .toContain('1 sentence');
    });
});

describe('een ontbrekende stap', () => {
    const plain = () => ({
        id: 'm-2',
        role: 'assistant',
        content: 'Goedemorgen!',
        phaseTrail: [step('building_prompt', { durationMs: 30 })],
    });

    it('een beurt zonder tools: twee regels ontbreken, met de reden', () => {
        render(<AnswerTracePanel msg={plain()} />);
        for (const id of ['sources', 'held_action']) {
            const row = rowFor(id);
            expect(row.getAttribute('data-state')).toBe('missing');
            expect(within(row).getByTestId('trace-missing').textContent)
                .toBe('The run recorded no such step.');
        }
    });

    it('BIJT — een ontbrekende regel toont GEEN feit en GEEN duur', () => {
        // Een gedempte regel met toch een getal erin is op het scherm niet van
        // een gemeten stap te onderscheiden.
        render(<AnswerTracePanel msg={plain()} />);
        const row = rowFor('sources');
        expect(within(row).queryByTestId('trace-fact')).toBeNull();
        expect(within(row).queryByTestId('duration-pill')).toBeNull();
    });

    it('BIJT — de reden gaat over de METING, niet over de agent', () => {
        // "The run recorded no such step" is waar. "The agent did not search"
        // weten we niet — dat de agent niets zocht is nooit gemeten.
        render(<AnswerTracePanel msg={plain()} />);
        const text = rowFor('sources').textContent.toLowerCase();
        expect(text).toContain('recorded');
        expect(text).not.toContain('did not search');
        expect(text).not.toContain('no knowledge');
    });

    it('zonder spoor zegt elke regel dat er niets opgetekend is', () => {
        render(<AnswerTracePanel msg={{ id: 'm-3', role: 'assistant', content: '' }} />);
        const rows = [...document.querySelectorAll('[data-testid="trace-row"]')];
        expect(rows.every(r => r.getAttribute('data-state') === 'missing')).toBe(true);
        expect(within(rowFor('question')).getByTestId('trace-missing').textContent)
            .toBe('No steps were recorded for this answer.');
    });

    it('BIJT — een zoekstap zonder passages zegt niet "0"', () => {
        // Nul passages betekent "niet gemeld", niet "niets gevonden".
        render(<AnswerTracePanel msg={{ ...fullTurn(), kbSources: [] }} />);
        const row = rowFor('sources');
        expect(row.getAttribute('data-state')).toBe('recorded');
        expect(row.textContent).not.toMatch(/\b0 passages?\b/);
        expect(within(row).getByTestId('trace-omitted').textContent)
            .toBe('Not shown: number of results — This step ran, but the number never came over the line.');
    });

    it('toon en taal staan onder regel 5 als weggelaten, met de reden', () => {
        render(<AnswerTracePanel msg={fullTurn()} />);
        const note = within(rowFor('answer')).getByTestId('trace-omitted');
        expect(note.getAttribute('data-reason')).toBe('not_measured');
        expect(note.textContent)
            .toBe('Not shown: tone, language — Nothing in this product measures this.');
    });
});

describe('geoordeeld ziet er anders uit', () => {
    it('de regelrij draagt het kopje met de uitleg als toegankelijke naam', () => {
        render(<AnswerTracePanel msg={fullTurn()} />);
        const judged = screen.getByTestId('trace-judged');
        expect(judged.textContent).toContain('Judged');
        expect(judged.getAttribute('aria-label')).toContain('This is its opinion');
        expect(screen.getByTestId('trace-rule').textContent)
            .toBe('Rule followed: Nooit een prijs noemen');
    });

    it('BIJT — hij draagt een andere VORM dan de opgetekende regels', () => {
        // Kleur alleen is geen drager: dit moet een schermafdruk in grijstinten
        // overleven. De gestippelde rand is die vorm.
        render(<AnswerTracePanel msg={fullTurn()} />);
        expect(screen.getByTestId('trace-judged').getAttribute('style'))
            .toContain('dashed');
        expect(rowFor('rule').getAttribute('data-state')).toBe('judged');
        expect(rowFor('sources').getAttribute('data-state')).toBe('recorded');
    });

    it('een beurt waarin de attributie ontbreekt: de regel is weg, met de reden', () => {
        render(<AnswerTracePanel msg={{ ...fullTurn(), ruleAttribution: null }} />);
        expect(screen.queryByTestId('trace-judged')).toBeNull();
        expect(within(rowFor('rule')).getByTestId('trace-missing').textContent)
            .toBe('No rule check ran for this answer, so there is nothing to attribute.');
    });

    it('BIJT — zonder attributie staat er geen regel die zegt dat er niets gevolgd is', () => {
        // Dat zou een bewering zijn uit de bron die net bewees niets te kunnen
        // beweren.
        render(<AnswerTracePanel msg={{ ...fullTurn(), ruleAttribution: { rules: [] } }} />);
        expect(rowFor('rule').textContent.toLowerCase()).not.toContain('rule followed');
        expect(rowFor('rule').textContent.toLowerCase()).not.toContain('no rule was');
    });
});

describe('een beslissing die alsnog valt', () => {
    it('eerst: aangeboden, niet gestart', () => {
        render(<AnswerTracePanel msg={fullTurn()} />);
        const held = screen.getByTestId('trace-held');
        expect(held.getAttribute('data-status')).toBe('pending');
        expect(held.textContent).toContain('Offered, not started');
        expect(held.textContent).toContain('leaves this workspace');
    });

    it('BIJT — een klik in deze sessie werkt het spoor bij', () => {
        const { rerender } = render(<AnswerTracePanel msg={fullTurn()} toolDecisions={{}} />);
        expect(screen.getByTestId('trace-held').textContent).toContain('Offered, not started');
        rerender(<AnswerTracePanel msg={fullTurn()} toolDecisions={{ [KEY]: 'approve' }} />);
        const held = screen.getByTestId('trace-held');
        expect(held.getAttribute('data-status')).toBe('approved');
        expect(held.textContent).toContain('it runs on your next message');
    });

    it('BIJT — een klik zegt NIET dat het gedraaid heeft', () => {
        // De beslissing reist mee met het volgende bericht; er is nog niets
        // gebeurd. "You approved this — it ran" zou daar onwaar zijn.
        render(<AnswerTracePanel msg={fullTurn()} toolDecisions={{ [KEY]: 'approve' }} />);
        expect(screen.getByTestId('trace-held').textContent).not.toContain('it ran');
    });

    it('een goedkeuring van de server zegt dat het WEL gedraaid heeft', () => {
        const msg = fullTurn();
        msg.pendingToolCalls = [{ ...msg.pendingToolCalls[0], status: 'approved' }];
        render(<AnswerTracePanel msg={msg} />);
        expect(screen.getByTestId('trace-held').textContent).toContain('it ran');
    });

    it('een afgewezen actie zegt dat hij niet gedraaid heeft', () => {
        render(<AnswerTracePanel msg={fullTurn()} toolDecisions={{ [KEY]: 'decline' }} />);
        expect(screen.getByTestId('trace-held').textContent).toContain('it did not run');
    });
});

describe('het paneel zelf', () => {
    it('blijft staan zonder antwoord, met een uitnodiging in plaats van regels', () => {
        render(<AnswerTracePanel msg={null} />);
        expect(screen.getByTestId('answer-trace').textContent)
            .toContain('Ask something to see how the answer was made.');
        expect(document.querySelectorAll('[data-testid="trace-row"]')).toHaveLength(0);
    });

    it('hangt de tijdlijn van de gedraaide tools eronder', () => {
        render(<AnswerTracePanel msg={fullTurn()} />);
        expect(screen.getByText('Tools this answer ran')).toBeTruthy();
        expect(screen.getByText('Tools Used')).toBeTruthy();
    });

    it('en laat die weg als er geen tool gedraaid heeft', () => {
        render(<AnswerTracePanel msg={{ ...fullTurn(), toolHistory: [] }} />);
        expect(screen.queryByText('Tools this answer ran')).toBeNull();
    });
});
