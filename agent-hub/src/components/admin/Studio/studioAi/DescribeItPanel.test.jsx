import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * "Describe it — AI picks the building blocks", the screen.
 *
 * Five things are fixed here, and four of them are a promise that is easy to
 * overstate:
 *
 *   1. three states — empty, busy, schema card — and nothing in between;
 *   2. the companions are SHOWN and NOT CREATED (that is H4b);
 *   3. cancelling aborts without inventing an error;
 *   4. the brief survives every failed attempt AND every "something else";
 *   5. a kind that the brief does not carry says so, with a copy button —
 *      instead of pretending something gets seeded; likewise for the NAME,
 *      which has its own flag and its own sentence;
 *   6. kinds whose gate the server could not read (`undecided`) are named on
 *      the card: otherwise a fault looks like a plan.
 */

const { fetchMock, routeMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), routeMock: vi.fn() }));

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: (...a) => fetchMock(...a) }));
vi.mock('./routeApi', () => ({ routeDescription: (...a) => routeMock(...a), ROUTE_ERROR_CODES: [] }));
vi.mock('../../../automation/Builder/flow/settings/FormBuilderFields', () => ({
    defaultFormDeclaration: () => ({ pages: [] }),
}));
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

import { STUDIO_APPS, resolveStudioNav } from '../studioApps';
import DescribeItPanel from './DescribeItPanel';
import { takeSeed } from './handoff';

const allOpen = () => resolveStudioNav(STUDIO_APPS, {
    user: {}, hasLicenseFeature: () => true, canUse: () => true, hasPermission: () => true,
    can: () => true, lockReason: () => null,
});

const plan = (over = {}) => ({
    ok: true, kind: 'automation', name: 'Weekrapport', seed: 'stuur elke maandag een rapport',
    companions: [], available: null, undecided: [], ...over,
});

const renderPanel = (props = {}) => render(
    <DescribeItPanel sections={allOpen()} onNavigate={props.onNavigate || vi.fn()} {...props} />,
);

const type = (value) => fireEvent.change(screen.getByTestId('studio-ai-input'), { target: { value } });

beforeEach(() => {
    fetchMock.mockReset();
    routeMock.mockReset();
    try { window.sessionStorage.clear(); } catch { /* geen storage */ }
});
afterEach(cleanup);

describe('toestand 1 — leeg', () => {
    it('toont het veld met de voorbeeldzin en de belofte, en de knop staat uit', () => {
        renderPanel();
        const input = screen.getByTestId('studio-ai-input');
        expect(input.placeholder).toMatch(/answers questions about our quotes/i);
        expect(screen.getByText(/picks the building blocks and shows you the plan first/i)).toBeTruthy();
        expect(screen.getByTestId('studio-ai-submit').disabled).toBe(true);
    });

    it('de knop gaat pas aan zodra er tekst staat', () => {
        renderPanel();
        type('  ');
        expect(screen.getByTestId('studio-ai-submit').disabled).toBe(true);
        type('een agent voor offertes');
        expect(screen.getByTestId('studio-ai-submit').disabled).toBe(false);
    });

    it('een lege beschrijving vraagt niets aan de router', async () => {
        const user = userEvent.setup();
        renderPanel();
        await user.click(screen.getByTestId('studio-ai-submit'));
        expect(routeMock).not.toHaveBeenCalled();
    });
});

describe('toestand 2 — bezig', () => {
    it('laat zien dat het bezig is, houdt de tekst leesbaar en de knop uit', async () => {
        const user = userEvent.setup();
        let resolve;
        routeMock.mockImplementation(() => new Promise((r) => { resolve = r; }));
        renderPanel();
        type('stuur elke maandag een rapport');
        await user.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-busy')).toBeTruthy());
        expect(screen.getByTestId('studio-ai-input').value).toBe('stuur elke maandag een rapport');
        expect(screen.getByTestId('studio-ai-submit').disabled).toBe(true);
        resolve(plan());
        await waitFor(() => expect(screen.getByTestId('studio-ai-plan')).toBeTruthy());
    });

    // Two roads to the same "no error": the signal is set to aborted (the test
    // below), and the router throws an AbortError while the signal does not yet
    // say so — for example because the fetch layer itself aborts. Both must not
    // put an error message on the screen.
    it('een AbortError van de router is geen fout op het scherm', async () => {
        const user = userEvent.setup();
        routeMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        renderPanel();
        type('een agent voor offertes');
        await user.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.queryByTestId('studio-ai-busy')).toBe(null));
        expect(screen.queryByTestId('studio-ai-error')).toBe(null);
        expect(screen.queryByTestId('studio-ai-plan')).toBe(null);
        expect(screen.getByTestId('studio-ai-input').value).toBe('een agent voor offertes');
    });

    it('annuleren breekt het verzoek af, verzint geen fout en houdt de brief', async () => {
        const user = userEvent.setup();
        let signal = null;
        routeMock.mockImplementation((text, opts) => new Promise((_res, rej) => {
            signal = opts.signal;
            opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        renderPanel();
        type('een agent voor offertes');
        await user.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-cancel')).toBeTruthy());
        await user.click(screen.getByTestId('studio-ai-cancel'));
        await waitFor(() => expect(screen.queryByTestId('studio-ai-busy')).toBe(null));
        expect(signal.aborted).toBe(true);
        expect(screen.queryByTestId('studio-ai-error')).toBe(null);
        expect(screen.getByTestId('studio-ai-input').value).toBe('een agent voor offertes');
    });
});

describe('toestand 3 — de schema-kaart', () => {
    const showPlan = async (over = {}, props = {}) => {
        routeMock.mockResolvedValue(plan(over));
        renderPanel(props);
        type('stuur elke maandag een rapport');
        fireEvent.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-plan')).toBeTruthy());
    };

    it('noemt de soort en de naam', async () => {
        await showPlan();
        expect(screen.getByText('New Automation: Weekrapport')).toBeTruthy();
        expect(screen.getByTestId('studio-ai-block-automation')).toBeTruthy();
    });

    it('zonder naam blijft het bij de soort', async () => {
        await showPlan({ name: '' });
        expect(screen.getByText('New Automation')).toBeTruthy();
    });

    it('toont de metgezellen mét de mededeling dat ze nog niet worden aangemaakt', async () => {
        await showPlan({ kind: 'agent', companions: [{ kind: 'kb', name: 'Offertes' }] });
        const row = screen.getByTestId('studio-ai-block-kb');
        expect(row.textContent).toMatch(/Offertes/);
        expect(row.textContent).toMatch(/does not create it yet/i);
    });

    it('"Maak dit" maakt ALLEEN de hoofdsoort aan — de metgezel niet (H4b)', async () => {
        const user = userEvent.setup();
        const onNavigate = vi.fn();
        await showPlan({ kind: 'agent', companions: [{ kind: 'kb', name: 'Offertes' }] }, { onNavigate });
        await user.click(screen.getByTestId('studio-ai-create'));
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/agents'));
        expect(onNavigate).toHaveBeenCalledTimes(1);
        expect(onNavigate).not.toHaveBeenCalledWith('studio/knowledge/new');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('draagt de naam mee naar de bouwer die er iets mee doet, en parkeert de brief', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ automation: { id: 'a7' } }), text: async () => '' });
        const onNavigate = vi.fn();
        await showPlan({}, { onNavigate });
        await user.click(screen.getByTestId('studio-ai-create'));
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/automations/a7'));
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).title).toBe('Weekrapport');
        expect(takeSeed('automation')).toBe('stuur elke maandag een rapport');
    });

    it('"Iets anders" brengt je terug naar het veld met de brief er nog in', async () => {
        const user = userEvent.setup();
        await showPlan();
        await user.click(screen.getByTestId('studio-ai-other'));
        expect(screen.queryByTestId('studio-ai-plan')).toBe(null);
        expect(screen.getByTestId('studio-ai-input').value).toBe('stuur elke maandag een rapport');
    });

    it('zonder brief van de server valt hij terug op wat de gebruiker zelf schreef', async () => {
        await showPlan({ kind: 'kb', seed: '' });
        expect(screen.getByTestId('studio-ai-seed-text').textContent).toBe('stuur elke maandag een rapport');
    });
});

describe('zaaien-eerlijkheid', () => {
    const showPlan = async (over = {}) => {
        routeMock.mockResolvedValue(plan(over));
        renderPanel();
        type('een kennisbank over onze offertes');
        fireEvent.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-plan')).toBeTruthy());
    };

    it('een soort die de brief niet meeneemt toont hem met een kopieerknop', async () => {
        const user = userEvent.setup();
        await showPlan({ kind: 'kb', name: 'Offertes', seed: 'alles over onze offertes' });
        expect(screen.getByTestId('studio-ai-seed-text').textContent).toBe('alles over onze offertes');
        expect(screen.getByText(/paste it into the assistant/i)).toBeTruthy();
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        await user.click(screen.getByTestId('studio-ai-copy'));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('alles over onze offertes'));
    });

    // THE REGRESSION THIS MUST CATCH: automation carried the NAME, so it was
    // marked "seedable", and the screen concealed the brief there — on the most
    // likely route of this screen. Today the brief reaches NO builder at all, so
    // the flag is false everywhere.
    it('ook bij automation staat de brief er, met de kopieerknop', async () => {
        await showPlan();
        expect(screen.getByTestId('studio-ai-seed')).toBeTruthy();
        expect(screen.getByTestId('studio-ai-seed-text').textContent).toBe('stuur elke maandag een rapport');
        expect(screen.getByTestId('studio-ai-copy')).toBeTruthy();
    });
});

// The heading says "New <kind>: <name>". For form, skill and kb a row then
// really comes into being — under "Untitled form" / "Untitled skill" / "New
// knowledge base". The screen may not conceal that.
describe('naam-eerlijkheid', () => {
    const showPlan = async (over = {}) => {
        routeMock.mockResolvedValue(plan(over));
        renderPanel();
        type('iets bouwen');
        fireEvent.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-plan')).toBeTruthy());
    };

    it.each(['kb', 'skill', 'agent'])('%s: de kop noemt een naam die niet meereist, en zegt dat', async (kind) => {
        await showPlan({ kind, name: 'Aanmelding open dag' });
        // De naam staat op de kop én in de bouwsteenrij — vandaar getAllByText.
        expect(screen.getAllByText(/Aanmelding open dag/).length).toBeGreaterThan(0);
        expect(screen.getByTestId('studio-ai-name').textContent).toMatch(/name does not travel along yet/i);
    });

    it('automation draagt de naam wél mee en zwijgt er dus over', async () => {
        await showPlan();
        expect(screen.queryByTestId('studio-ai-name')).toBe(null);
    });

    it('form draagt naam ÉN brief mee: de Form-pagina stelt er de vragen uit op', async () => {
        await showPlan({ kind: 'form', name: 'Aanmelding open dag' });
        expect(screen.queryByTestId('studio-ai-name')).toBe(null);
        expect(screen.queryByTestId('studio-ai-seed')).toBe(null);
    });

    it('zonder naam is er niets te beloven en dus niets te melden', async () => {
        await showPlan({ kind: 'kb', name: '' });
        expect(screen.queryByTestId('studio-ai-name')).toBe(null);
    });
});

// House rule 12 on the plan card: the server has already made the narrow choice
// (an unreadable gate removes the kind from the model's word list), and without
// a word about that a fault looks like a confident plan.
describe('onleesbare poorten staan op de kaart', () => {
    const showPlan = async (over = {}) => {
        routeMock.mockResolvedValue(plan(over));
        renderPanel();
        type('een app voor offertes');
        fireEvent.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-plan')).toBeTruthy());
    };

    it('noemt de soorten die niet te beoordelen waren, bij naam', async () => {
        await showPlan({ kind: 'kb', name: 'Offertes', available: ['kb', 'automation'], undecided: ['app', 'webpage'] });
        const line = screen.getByTestId('studio-ai-undecided').textContent;
        expect(line).toMatch(/could not check every building block/i);
        expect(line).toMatch(/App/);
        expect(line).toMatch(/Webpage/);
        // …and the card stays usable: this is a caveat, not a block.
        expect(screen.getByTestId('studio-ai-create').disabled).toBe(false);
    });

    it('zonder onleesbare poorten staat die zin er niet', async () => {
        await showPlan({ kind: 'kb', available: ['kb'], undecided: [] });
        expect(screen.queryByTestId('studio-ai-undecided')).toBe(null);
    });

    it('ook een gelockte kaart vertelt wat er niet te lezen viel', async () => {
        const user = userEvent.setup();
        routeMock.mockResolvedValue(plan({ kind: 'app', name: 'Offertehulp', available: ['app'], undecided: ['skill'] }));
        render(<DescribeItPanel sections={allOpen().map((s) => (s.id === 'apps' ? { ...s, locked: 'ceiling' } : s))} onNavigate={vi.fn()} />);
        type('een app voor offertes');
        await user.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-plan')).toBeTruthy());
        expect(screen.getByTestId('studio-ai-undecided').textContent).toMatch(/Skill/);
        expect(screen.getByTestId('studio-ai-create').disabled).toBe(true);
    });
});

describe('fouten — nooit stilletjes een soort kiezen', () => {
    const submitWith = async (result) => {
        routeMock.mockResolvedValue(result);
        renderPanel();
        type('doe iets');
        fireEvent.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-error')).toBeTruthy());
    };

    it.each([
        ['no_model', /no ai model is set up/i],
        ['ai_unusable', /a little more concretely/i],
        ['rate_limited', /wait a moment/i],
        ['failed', /could not read that/i],
        ['no_text', /type a short description/i],
    ])('code %s krijgt zijn eigen zin', async (code, pattern) => {
        await submitWith({ ok: false, code });
        expect(screen.getByTestId('studio-ai-error').textContent).toMatch(pattern);
        expect(screen.queryByTestId('studio-ai-plan')).toBe(null);
    });

    it('no_model wijst de uitweg naar het "Nieuw"-menu', async () => {
        await submitWith({ ok: false, code: 'no_model' });
        expect(screen.getByTestId('studio-ai-error').textContent).toMatch(/pick a building block from new/i);
    });

    it('de brief blijft staan na een mislukte poging', async () => {
        await submitWith({ ok: false, code: 'failed' });
        expect(screen.getByTestId('studio-ai-input').value).toBe('doe iets');
    });

    it('een antwoord zonder soort wordt een vraag om het concreter te zeggen, geen gok', async () => {
        await submitWith({ ok: true, kind: null, name: '', seed: '', companions: [], available: ['automation', 'kb'], undecided: [] });
        expect(screen.getByTestId('studio-ai-error').textContent).toMatch(/a little more concretely/i);
        expect(screen.queryByTestId('studio-ai-plan')).toBe(null);
    });

    // House rule 12 on the screen: "you may not build anything here" and "we could
    // not work it out" look like an empty answer, and they are not. One sentence
    // for both would wipe out the difference.
    it('"je mag hier niets bouwen" krijgt zijn eigen zin', async () => {
        await submitWith({ ok: true, kind: null, name: '', seed: '', companions: [], available: [], undecided: [] });
        expect(screen.getByTestId('studio-ai-error').textContent).toMatch(/nothing here you can build yet/i);
    });

    it('"we konden de gates niet lezen" krijgt een ANDERE zin', async () => {
        await submitWith({ ok: true, kind: null, name: '', seed: '', companions: [], available: [], undecided: ['app'] });
        expect(screen.getByTestId('studio-ai-error').textContent).toMatch(/could not work out what you may build/i);
    });

    it('een omgevallen router laat het scherm niet omvallen', async () => {
        const user = userEvent.setup();
        routeMock.mockRejectedValue(new Error('boom'));
        renderPanel();
        type('doe iets');
        await user.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-error').textContent).toMatch(/could not read that/i));
    });
});

describe('de tweede rem — een soort die deze lezer niet mag', () => {
    const lockedSections = () => allOpen().map((s) => (s.id === 'apps' ? { ...s, locked: 'ceiling' } : s));

    it('toont de kaart met de lock-hint en zonder actieve knop', async () => {
        const user = userEvent.setup();
        routeMock.mockResolvedValue(plan({ kind: 'app', name: 'Offertehulp' }));
        const onNavigate = vi.fn();
        render(<DescribeItPanel sections={lockedSections()} onNavigate={onNavigate} />);
        type('een app voor offertes');
        await user.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-plan')).toBeTruthy());
        expect(screen.getByTestId('studio-ai-lock').textContent).toMatch(/available on a higher plan/i);
        expect(screen.getByTestId('studio-ai-create').disabled).toBe(true);
        await user.click(screen.getByTestId('studio-ai-create'));
        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.queryByTestId('studio-ai-seed')).toBe(null);
    });

    it('staat de soort niet in de eigen available-lijst van de server, dan telt dat ook', async () => {
        const user = userEvent.setup();
        routeMock.mockResolvedValue(plan({ kind: 'agent', available: ['kb', 'automation'] }));
        const onNavigate = vi.fn();
        renderPanel({ onNavigate });
        type('een agent');
        await user.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-plan')).toBeTruthy());
        expect(screen.getByTestId('studio-ai-create').disabled).toBe(true);
        expect(screen.getByTestId('studio-ai-lock')).toBeTruthy();
    });
});

describe('twee omhulsels, één scherm', () => {
    it('inline is de kaart zelf', () => {
        renderPanel();
        expect(screen.getByTestId('studio-ai-panel').dataset.variant).toBe('inline');
    });

    it('modal toont dezelfde kaart in een dialoog en verdwijnt als hij dicht is', () => {
        const { rerender } = render(<DescribeItPanel sections={allOpen()} onNavigate={vi.fn()} variant="modal" open onClose={vi.fn()} />);
        expect(screen.getByTestId('studio-ai-panel').dataset.variant).toBe('modal');
        expect(screen.getByTestId('studio-ai-input')).toBeTruthy();
        rerender(<DescribeItPanel sections={allOpen()} onNavigate={vi.fn()} variant="modal" open={false} onClose={vi.fn()} />);
        expect(screen.queryByTestId('studio-ai-input')).toBe(null);
    });

    it('sluit het omhulsel zodra er echt iets is aangemaakt', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        routeMock.mockResolvedValue(plan({ kind: 'kb' }));
        render(<DescribeItPanel sections={allOpen()} onNavigate={vi.fn()} variant="modal" open onClose={onClose} />);
        type('een kennisbank');
        await user.click(screen.getByTestId('studio-ai-submit'));
        await waitFor(() => expect(screen.getByTestId('studio-ai-plan')).toBeTruthy());
        await user.click(screen.getByTestId('studio-ai-create'));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
});
