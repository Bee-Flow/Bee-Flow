import { render as rtlRender, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The card on the Start screen. What is pinned here are the things that silently go wrong:
 *
 *   1. a counter that could not be read is NOT a 0 — and a genuine 0 is a 0;
 *   2. the plate is not the information: the SVG is invisible to the screen reader,
 *      and all eleven connections stand in the DOM as a sentence;
 *   3. clicking lights up precisely its own edges, and dims the rest;
 *   4. the scope determines only the SENTENCE under the number, and a scope we do
 *      not know narrows to the most cautious sentence.
 *
 * The model side (the ten kinds, the eleven edges, the geometry, the chrome) is in
 * studioMap.test.js — that is the drift test, this one is the screen.
 */

const { authFetchMock, countsSpy } = vi.hoisted(() => ({ authFetchMock: vi.fn(), countsSpy: vi.fn() }));

vi.mock('@/utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    API_BASE: '',
    authFetch: (...args) => authFetchMock(...args),
}));

// The real hook, with a spy on the OPTIONS. `poll: false` is the whole reason that
// this card places no second poller next to the rail's, and without this pin that
// choice disappears at the first refactor without a single red test.
vi.mock('@/hooks/useStudioCounts', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        useStudioCounts: (opts) => { countsSpy(opts); return actual.useStudioCounts(opts); },
    };
});

vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

import { queryWrapper } from '@/test/queryWrapper';
import { MAP_EDGES, edgesOf, scopeSentence } from './studioMap';
import StudioMap from './StudioMap';
import { MAP_BLOCKS } from './studioMap.constants';

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
        // and the tiles are real buttons, not shapes in a plate
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

        it('toont voor een sleutel die het antwoord niet had GEEN nul', async () => {
            const user = userEvent.setup();
            render(<StudioMap counts={{ automations: 9 }} />);
            // 'agents' was not in the answer: not allowed to see and failed are
            // indistinguishable, and both are not zero.
            expect(screen.queryByTestId('studio-map-count-agent')).toBeNull();
            const dash = screen.getByTestId('studio-map-count-agent-unknown');
            expect(dash.textContent.startsWith('—')).toBe(true);
            expect(dash.textContent).not.toBe('0');
            // The sentence is also there for whoever does not see the dash: a `title` is not
            // spoken by every screen reader, and the dash is the only difference from
            // “no answer yet”.
            expect(dash.textContent).toMatch(/not the same as none/i);
            await user.click(screen.getByTestId('studio-map-tile-agent'));
            expect(screen.getByTestId('studio-map-detail-unknown').textContent).toMatch(/not the same as none/i);
        });

        it('beweert niets zolang er nog geen antwoord is', async () => {
            const user = userEvent.setup();
            authFetchMock.mockReturnValue(new Promise(() => {}));
            render(<StudioMap />);
            expect(screen.queryByTestId('studio-map-count-automation')).toBeNull();
            expect(screen.queryByTestId('studio-map-count-automation-unknown')).toBeNull();
            await user.click(screen.getByTestId('studio-map-tile-automation'));
            expect(screen.getByTestId('studio-map-detail-pending')).toBeTruthy();
        });

        it('telt de goedkeuring niet, en zegt waarom', async () => {
            const user = userEvent.setup();
            render(<StudioMap counts={{ automations: 9 }} />);
            expect(screen.queryByTestId('studio-map-count-approval')).toBeNull();
            expect(screen.queryByTestId('studio-map-count-approval-unknown')).toBeNull();
            await user.click(screen.getByTestId('studio-map-tile-approval'));
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
            const user = userEvent.setup();
            authFetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
            render(<StudioMap />);
            // A 500 is not “wait a little longer”: this card does not poll, so that number
            // will not come any more. The dash plus its sentence is the honest answer;
            // “The number is not in yet” would be a promise that is never kept.
            await waitFor(() => expect(screen.getByTestId('studio-map-count-kb-unknown')).toBeTruthy());
            expect(screen.queryByTestId('studio-map-count-kb')).toBeNull();
            await user.click(screen.getByTestId('studio-map-tile-kb'));
            expect(screen.queryByTestId('studio-map-detail-pending')).toBeNull();
            expect(screen.getByTestId('studio-map-detail-unknown').textContent).toMatch(/could not be read/i);
        });

        it('een ouder die zelf niet kon lezen geeft dat door', async () => {
            const user = userEvent.setup();
            render(<StudioMap counts={null} countsFailed />);
            expect(authFetchMock).not.toHaveBeenCalled();
            expect(screen.getByTestId('studio-map-count-kb-unknown')).toBeTruthy();
            await user.click(screen.getByTestId('studio-map-tile-kb'));
            expect(screen.queryByTestId('studio-map-detail-pending')).toBeNull();
        });

        it('`null` van de ouder is een ANTWOORD, geen ontbrekende prop', () => {
            // countsProp === undefined is the only state in which the card reads itself. If
            // this were `== null`, the card would override a parent that has just said it
            // does not have them.
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
        it('noemt de gekozen scope onder het getal', async () => {
            const user = userEvent.setup();
            render(<StudioMap counts={{ agents: 9 }} scope="org" />);
            await user.click(screen.getByTestId('studio-map-tile-agent'));
            const line = screen.getByTestId('studio-map-detail-count').textContent;
            expect(line).toContain('9');
            expect(line).toMatch(/everything in the organisation/i);
        });

        it('zegt NIET "de hele organisatie" over een teller die de server per gebruiker telt', async () => {
            const user = userEvent.setup();
            // GET /api/studio/counts has no scope parameter, and counts `automations` with
            // `WHERE user_id = $1`. A strip that passes 'org' thus does not change that
            // number — only the sentence under it, and that would then turn nine of one's
            // own automations into an organisation fact.
            render(<StudioMap counts={{ automations: 9 }} scope="org" />);
            await user.click(screen.getByTestId('studio-map-tile-automation'));
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
            // And per key: everything that the server does not count org-wide gets the visible
            // sentence, however broad the strip above it is.
            for (const key of ['automations', 'runs', 'solutions', 'apps', null]) {
                expect(scopeSentence(t, 'org', key), String(key)).toMatch(/what you can see/i);
            }
        });
    });

    describe('klikken op een tegel', () => {
        it('licht precies de eigen randen op en dooft de rest', async () => {
            const user = userEvent.setup();
            render(<StudioMap counts={null} />);
            await user.click(screen.getByTestId('studio-map-tile-app'));
            expect(screen.getByTestId('studio-map-tile-app').getAttribute('aria-pressed')).toBe('true');
            const own = new Set(edgesOf('app').map((e) => e.id));
            expect(own.size).toBe(3);
            for (const edge of MAP_EDGES) {
                const lit = own.has(edge.id) ? 'true' : null;
                expect(screen.getByTestId(`studio-map-edge-${edge.id}`).getAttribute('data-on'), edge.id).toBe(lit);
                expect(screen.getByTestId(`studio-map-sentence-${edge.id}`).getAttribute('data-on'), edge.id).toBe(lit);
            }
        });

        it('laat de dozen aan de andere kant van die randen wél staan', async () => {
            const user = userEvent.setup();
            render(<StudioMap counts={null} />);
            await user.click(screen.getByTestId('studio-map-tile-app'));
            expect(screen.getByTestId('studio-map-tile-automation').getAttribute('data-dimmed')).toBeNull();
            expect(screen.getByTestId('studio-map-tile-datatable').getAttribute('data-dimmed')).toBeNull();
            expect(screen.getByTestId('studio-map-tile-approval').getAttribute('data-dimmed')).toBeNull();
            // a neighbour from another lane does not belong here
            expect(screen.getByTestId('studio-map-tile-skill').getAttribute('data-dimmed')).toBe('true');
        });

        it('zegt van een oplossing eerlijk dat er niets aan hangt', async () => {
            const user = userEvent.setup();
            render(<StudioMap counts={{ solutions: 2 }} />);
            await user.click(screen.getByTestId('studio-map-tile-solution'));
            expect(screen.getByTestId('studio-map-detail').textContent).toMatch(/the box the others travel in/i);
        });

        it('telt de verbindingen van de gekozen doos', async () => {
            const user = userEvent.setup();
            render(<StudioMap counts={null} />);
            await user.click(screen.getByTestId('studio-map-tile-automation'));
            expect(screen.getByTestId('studio-map-detail').textContent)
                .toContain(`${edgesOf('automation').length} connections`);
        });

        it('klapt de selectie weer dicht bij een tweede klik', async () => {
            const user = userEvent.setup();
            render(<StudioMap counts={null} />);
            const tile = screen.getByTestId('studio-map-tile-kb');
            await user.click(tile);
            expect(tile.getAttribute('aria-pressed')).toBe('true');
            await user.click(tile);
            expect(tile.getAttribute('aria-pressed')).toBe('false');
            expect(screen.getByTestId('studio-map-detail').textContent).toMatch(/Pick a building block/i);
        });
    });
});
