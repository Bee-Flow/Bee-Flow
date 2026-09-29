import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * De kaart op het Startscherm. Wat hier vastligt zijn de dingen die stil
 * verkeerd gaan:
 *
 *   1. een teller die niet gelezen kon worden is GEEN 0 — en een echte 0 is
 *      wél een 0;
 *   2. de plaat is niet de informatie: de SVG is voor de schermlezer
 *      onzichtbaar, en alle elf verbindingen staan als zin in de DOM;
 *   3. klikken licht precies de eigen randen op, en dooft de rest;
 *   4. de scope bepaalt alleen de ZIN onder het getal, en een scope die we
 *      niet kennen versmalt naar de voorzichtigste zin.
 *
 * De model-kant (de tien soorten, de elf randen, de meetkunde, de chrome)
 * staat in studioMap.test.js — die is de drifttest, deze is het scherm.
 */

const { authFetchMock, countsSpy } = vi.hoisted(() => ({ authFetchMock: vi.fn(), countsSpy: vi.fn() }));

vi.mock('../../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    API_BASE: '',
    authFetch: (...args) => authFetchMock(...args),
}));

// De echte hook, met een spion op de OPTIES. `poll: false` is de hele reden
// dat deze kaart geen tweede poller naast die van de rail zet, en zonder deze
// pin verdwijnt die keuze bij de eerste refactor zonder één rode test.
vi.mock('../../../../hooks/useStudioCounts', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        useStudioCounts: (opts) => { countsSpy(opts); return actual.useStudioCounts(opts); },
    };
});

vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let value = typeof fallback === 'string' ? fallback : key;
            const p = typeof fallback === 'string' ? params : fallback;
            if (p && typeof p === 'object') {
                for (const [k, v] of Object.entries(p)) value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
            }
            return value;
        },
        locale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

import { MAP_BLOCKS, MAP_EDGES, edgesOf, scopeSentence } from './studioMap';
import StudioMap from './StudioMap.jsx';
import { queryWrapper } from '../../../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

const answer = (counts) => ({ ok: true, json: async () => ({ counts, makers: 3 }) });

describe('StudioMap', () => {
    beforeEach(() => {
        cleanup();
        authFetchMock.mockReset();
        countsSpy.mockReset();
        authFetchMock.mockResolvedValue(answer({}));
    });

    it('tekent elke bouwsteen, de goedkeuring erbij, en telt ze in de kop', () => {
        render(<StudioMap counts={null} />);
        for (const block of MAP_BLOCKS) {
            expect(screen.getByTestId(`studio-map-tile-${block.id}`), block.id).toBeTruthy();
        }
        expect(screen.getByTestId('studio-map-tile-approval')).toBeTruthy();
        const head = screen.getByTestId('studio-map-counts').textContent;
        expect(head).toContain(`${MAP_BLOCKS.length} building blocks`);
        expect(head).toContain(`${MAP_EDGES.length} connections`);
    });

    it('is niet plaatje-alleen: de SVG is verborgen en elke verbinding staat er als zin', () => {
        render(<StudioMap counts={null} />);
        expect(screen.getByTestId('studio-map-svg').getAttribute('aria-hidden')).toBe('true');
        for (const edge of MAP_EDGES) {
            const li = screen.getByTestId(`studio-map-sentence-${edge.id}`);
            expect(li.textContent, edge.id).toContain(edge.labelFallback);
        }
        // en de tegels zijn echte knoppen, geen vormpjes in een plaat
        expect(screen.getByTestId('studio-map-tile-agent').tagName).toBe('BUTTON');
        // het werkwoord staat op de rand zelf, uit het vocabulaire
        expect(screen.getByTestId('studio-map-edge-agent-grounds-kb').textContent).toBe('grounds');
        expect(screen.getByTestId('studio-map-edge-automation-datatable').textContent).toBe('reads · writes');
    });

    describe('tellers', () => {
        it('toont een getal dat er is, en een echte nul als nul', () => {
            render(<StudioMap counts={{ automations: 9, apps: 0 }} />);
            expect(screen.getByTestId('studio-map-count-automation').textContent).toBe('9');
            expect(screen.getByTestId('studio-map-count-app').textContent).toBe('0');
        });

        it('toont voor een sleutel die het antwoord niet had GEEN nul', () => {
            render(<StudioMap counts={{ automations: 9 }} />);
            // 'agents' zat niet in het antwoord: niet mogen zien en omgevallen
            // zijn ononderscheidbaar, en allebei zijn ze geen nul.
            expect(screen.queryByTestId('studio-map-count-agent')).toBeNull();
            const dash = screen.getByTestId('studio-map-count-agent-unknown');
            expect(dash.textContent.startsWith('—')).toBe(true);
            expect(dash.textContent).not.toBe('0');
            // De zin staat er ook voor wie het streepje niet ziet: een `title`
            // spreekt niet elke schermlezer uit, en het streepje is het enige
            // verschil met "nog geen antwoord".
            expect(dash.textContent).toMatch(/not the same as none/i);
            fireEvent.click(screen.getByTestId('studio-map-tile-agent'));
            expect(screen.getByTestId('studio-map-detail-unknown').textContent).toMatch(/not the same as none/i);
        });

        it('beweert niets zolang er nog geen antwoord is', () => {
            authFetchMock.mockReturnValue(new Promise(() => {}));
            render(<StudioMap />);
            expect(screen.queryByTestId('studio-map-count-automation')).toBeNull();
            expect(screen.queryByTestId('studio-map-count-automation-unknown')).toBeNull();
            fireEvent.click(screen.getByTestId('studio-map-tile-automation'));
            expect(screen.getByTestId('studio-map-detail-pending')).toBeTruthy();
        });

        it('telt de goedkeuring niet, en zegt waarom', () => {
            render(<StudioMap counts={{ automations: 9 }} />);
            expect(screen.queryByTestId('studio-map-count-approval')).toBeNull();
            expect(screen.queryByTestId('studio-map-count-approval-unknown')).toBeNull();
            fireEvent.click(screen.getByTestId('studio-map-tile-approval'));
            expect(screen.getByTestId('studio-map-detail-not-counted')).toBeTruthy();
        });

        it('haalt de tellers één keer op als niemand anders ze bezit', async () => {
            authFetchMock.mockResolvedValue(answer({ knowledge: 4 }));
            render(<StudioMap />);
            await waitFor(() => expect(screen.getByTestId('studio-map-count-kb').textContent).toBe('4'));
            expect(authFetchMock).toHaveBeenCalledTimes(1);
            expect(authFetchMock.mock.calls[0][0]).toBe('/api/studio/counts');
        });

        it('laat een mislukte telling geen getallen verzinnen, en belooft er ook geen', async () => {
            authFetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
            render(<StudioMap />);
            // Een 500 is geen "nog even wachten": deze kaart pollt niet, dus
            // dat getal komt niet meer. Het streepje plus zijn zin is het
            // eerlijke antwoord; "The number is not in yet" zou een belofte
            // zijn die nooit wordt ingelost.
            await waitFor(() => expect(screen.getByTestId('studio-map-count-kb-unknown')).toBeTruthy());
            expect(screen.queryByTestId('studio-map-count-kb')).toBeNull();
            fireEvent.click(screen.getByTestId('studio-map-tile-kb'));
            expect(screen.queryByTestId('studio-map-detail-pending')).toBeNull();
            expect(screen.getByTestId('studio-map-detail-unknown').textContent).toMatch(/could not be read/i);
        });

        it('een ouder die zelf niet kon lezen geeft dat door', () => {
            render(<StudioMap counts={null} countsFailed />);
            expect(authFetchMock).not.toHaveBeenCalled();
            expect(screen.getByTestId('studio-map-count-kb-unknown')).toBeTruthy();
            fireEvent.click(screen.getByTestId('studio-map-tile-kb'));
            expect(screen.queryByTestId('studio-map-detail-pending')).toBeNull();
        });

        it('`null` van de ouder is een ANTWOORD, geen ontbrekende prop', () => {
            // countsProp === undefined is de enige toestand waarin de kaart
            // zelf gaat lezen. Zou dit `== null` zijn, dan overrulet de kaart
            // een ouder die net gezegd heeft dat hij ze niet heeft.
            render(<StudioMap counts={null} />);
            expect(authFetchMock).not.toHaveBeenCalled();
        });

        it('leest ÉÉN keer, zonder poller', () => {
            authFetchMock.mockReturnValue(new Promise(() => {}));
            render(<StudioMap />);
            expect(countsSpy).toHaveBeenCalledWith({ enabled: true, poll: false });
        });

        it('vraagt de hook niets wanneer de ouder de tellers bezit', () => {
            render(<StudioMap counts={{ automations: 1 }} />);
            expect(countsSpy).toHaveBeenCalledWith({ enabled: false, poll: false });
        });

        it('haalt niets op wanneer de scope-strip de tellers doorgeeft', () => {
            render(<StudioMap counts={{ automations: 1 }} scope="org" />);
            expect(authFetchMock).not.toHaveBeenCalled();
        });
    });

    describe('de scope zegt alleen waar het getal over gaat', () => {
        it('noemt de gekozen scope onder het getal', () => {
            render(<StudioMap counts={{ agents: 9 }} scope="org" />);
            fireEvent.click(screen.getByTestId('studio-map-tile-agent'));
            const line = screen.getByTestId('studio-map-detail-count').textContent;
            expect(line).toContain('9');
            expect(line).toMatch(/everything in the organisation/i);
        });

        it('zegt NIET "de hele organisatie" over een teller die de server per gebruiker telt', () => {
            // GET /api/studio/counts kent geen scope-parameter, en telt
            // `automations` met `WHERE user_id = $1`. Een strip die 'org'
            // doorgeeft verandert dat getal dus niet — alleen de zin eronder,
            // en die zou dan negen eigen routines tot een organisatiefeit
            // maken.
            render(<StudioMap counts={{ automations: 9 }} scope="org" />);
            fireEvent.click(screen.getByTestId('studio-map-tile-automation'));
            const line = screen.getByTestId('studio-map-detail-count').textContent;
            expect(line).toContain('9');
            expect(line).toMatch(/what you can see/i);
            expect(line).not.toMatch(/organisation/i);
        });

        it('versmalt een scope die we niet kennen — nooit naar de hele organisatie', () => {
            const t = (key, fallback) => fallback;
            expect(scopeSentence(t, 'org', 'agents')).toMatch(/organisation/i);
            expect(scopeSentence(t, 'mine')).toMatch(/only what you made/i);
            expect(scopeSentence(t, 'solution')).toMatch(/chosen solution/i);
            for (const unknown of [null, undefined, '', 'ORG', 'org ', 'everything', { kind: 'org' }]) {
                expect(scopeSentence(t, unknown), String(unknown)).toMatch(/what you can see/i);
            }
            // En per sleutel: alles wat de server niet org-breed telt krijgt
            // de zichtbare zin, hoe breed de strip erboven ook staat.
            for (const key of ['automations', 'runs', 'solutions', 'apps', null]) {
                expect(scopeSentence(t, 'org', key), String(key)).toMatch(/what you can see/i);
            }
        });
    });

    describe('klikken op een tegel', () => {
        it('licht precies de eigen randen op en dooft de rest', () => {
            render(<StudioMap counts={null} />);
            fireEvent.click(screen.getByTestId('studio-map-tile-app'));
            expect(screen.getByTestId('studio-map-tile-app').getAttribute('aria-pressed')).toBe('true');
            const own = new Set(edgesOf('app').map((e) => e.id));
            expect(own.size).toBe(3);
            for (const edge of MAP_EDGES) {
                const lit = own.has(edge.id) ? 'true' : null;
                expect(screen.getByTestId(`studio-map-edge-${edge.id}`).getAttribute('data-on'), edge.id).toBe(lit);
                expect(screen.getByTestId(`studio-map-sentence-${edge.id}`).getAttribute('data-on'), edge.id).toBe(lit);
            }
        });

        it('laat de dozen aan de andere kant van die randen wél staan', () => {
            render(<StudioMap counts={null} />);
            fireEvent.click(screen.getByTestId('studio-map-tile-app'));
            expect(screen.getByTestId('studio-map-tile-automation').getAttribute('data-dimmed')).toBeNull();
            expect(screen.getByTestId('studio-map-tile-datatable').getAttribute('data-dimmed')).toBeNull();
            expect(screen.getByTestId('studio-map-tile-approval').getAttribute('data-dimmed')).toBeNull();
            // een buur uit een andere laan hoort er niet bij
            expect(screen.getByTestId('studio-map-tile-skill').getAttribute('data-dimmed')).toBe('true');
        });

        it('zegt van een oplossing eerlijk dat er niets aan hangt', () => {
            render(<StudioMap counts={{ solutions: 2 }} />);
            fireEvent.click(screen.getByTestId('studio-map-tile-solution'));
            expect(screen.getByTestId('studio-map-detail').textContent).toMatch(/the box the others travel in/i);
        });

        it('telt de verbindingen van de gekozen doos', () => {
            render(<StudioMap counts={null} />);
            fireEvent.click(screen.getByTestId('studio-map-tile-automation'));
            expect(screen.getByTestId('studio-map-detail').textContent)
                .toContain(`${edgesOf('automation').length} connections`);
        });

        it('klapt de selectie weer dicht bij een tweede klik', () => {
            render(<StudioMap counts={null} />);
            const tile = screen.getByTestId('studio-map-tile-kb');
            fireEvent.click(tile);
            expect(tile.getAttribute('aria-pressed')).toBe('true');
            fireEvent.click(tile);
            expect(tile.getAttribute('aria-pressed')).toBe('false');
            expect(screen.getByTestId('studio-map-detail').textContent).toMatch(/Pick a building block/i);
        });
    });
});
