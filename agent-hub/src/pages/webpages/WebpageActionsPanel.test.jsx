import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WebpageActionsPanel — de kolom "Laat gebeuren".
 *
 * `authFetch` levert het contract van GET /api/webpages/:id/bindings (server:
 * core/webpages/webpageBindings.js); het grants-paneel eronder is gemockt, want
 * dat heeft zijn eigen test — hier telt alleen DAT het gepromoveerd is.
 *
 * Wat hier vastligt is wat het scherm mag BEWEREN: een onleesbare scan leest
 * nooit als "deze pagina doet niets", niet-herleidbare oproepen worden benoemd,
 * de leeshulp-disclaimer staat er altijd, en wat "Maak er een automation van"
 * aanmaakt bevat het vaste deel van de URL — nooit het beletselteken.
 */

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

const createAutomation = vi.fn();
vi.mock('../../hooks/useAutomationApi', () => ({
    default: () => ({ createAutomation: (...args) => createAutomation(...args) }),
}));

vi.mock('./WebpageAppsPanel', () => ({
    default: ({ webpageId }) => <div data-testid="apps-panel">{`grants for ${webpageId}`}</div>,
}));

import WebpageActionsPanel, { scaffoldHttpAutomation, automationDeepLink } from './WebpageActionsPanel';

const CALL = {
    kind: 'fetch', method: null, url: 'https://api.vendor.com/v1/rates',
    urlPrefix: 'https://api.vendor.com/v1/rates', dynamic: false,
    host: 'api.vendor.com', source: 'script.js', line: 12, occurrences: 1,
};

const BINDINGS = {
    code: { scanned: true, calls: [CALL], externalCount: 1, unresolved: 0, internal: 3 },
    // `supported: true` sinds bf-form en bf-agent echt bestaan; de kaart leest
    // nu de ECHTE elementen in plaats van te beweren dat ze niet bestaan.
    forms: { supported: true, scanned: true },
    elements: { scanned: true, marks: [], counts: { total: 0, known: 0, unknown: 0 }, unknownTags: [], truncated: 0 },
    uses: { scanned: true, targets: { datatable: [], automation: [], agent: [] }, unresolved: [] },
    agent: { known: true, agentId: null, supported: true, internalOnly: true },
};

function response(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function clone(over = {}) {
    return JSON.parse(JSON.stringify({ ...BINDINGS, ...over }));
}

beforeEach(() => { authFetch.mockReset(); createAutomation.mockReset(); });

describe('WebpageActionsPanel', () => {
    it('shows a dashed "does something in its own code" card with file, line and host', async () => {
        authFetch.mockResolvedValue(response(clone()));
        render(<WebpageActionsPanel webpageId="wp1" />);

        expect(await screen.findByText('api.vendor.com')).toBeInTheDocument();
        expect(screen.getByText('Does something in its own code')).toBeInTheDocument();
        expect(screen.getByText(/does not show up in Runs and has no approval step/)).toBeInTheDocument();
        expect(screen.getByText('script.js:12 · fetch()')).toBeInTheDocument();
        expect(screen.getByText('https://api.vendor.com/v1/rates')).toBeInTheDocument();
    });

    it('scaffolds an http_request automation with that URL and deep-links to it', async () => {
        authFetch.mockResolvedValue(response(clone()));
        createAutomation.mockResolvedValue({ automation: { id: 'auto_9' } });
        const onNavigate = vi.fn();
        render(<WebpageActionsPanel webpageId="wp1" onNavigate={onNavigate} />);

        fireEvent.click(await screen.findByText('Turn it into an automation'));

        await waitFor(() => expect(createAutomation).toHaveBeenCalledTimes(1));
        const body = createAutomation.mock.calls[0][0];
        expect(body.definition.steps[0].type).toBe('http_request');
        expect(body.definition.steps[0].url).toBe('https://api.vendor.com/v1/rates');
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/automations/auto_9'));
    });

    it('a refused automation (no licence) says so instead of showing a stack trace', async () => {
        authFetch.mockResolvedValue(response(clone()));
        createAutomation.mockRejectedValue(new Error('403 Forbidden'));
        render(<WebpageActionsPanel webpageId="wp1" />);

        fireEvent.click(await screen.findByText('Turn it into an automation'));
        expect(await screen.findByRole('alert')).toHaveTextContent('not part of this plan');
    });

    it('unreadable code reads as unknown, never as "nothing happens here"', async () => {
        authFetch.mockResolvedValue(response(clone({
            code: { scanned: false, calls: [], externalCount: 0, unresolved: 0, internal: 0 },
        })));
        render(<WebpageActionsPanel webpageId="wp1" />);

        expect(await screen.findByText('This page\'s own code could not be read')).toBeInTheDocument();
        expect(screen.getByText(/which is not the same as nothing/)).toBeInTheDocument();
        expect(screen.queryByText(/No calls to other services found/)).toBeNull();
    });

    it('a clean scan says what it found AND what it can never see', async () => {
        authFetch.mockResolvedValue(response(clone({
            code: { scanned: true, calls: [], externalCount: 0, unresolved: 0, internal: 2 },
        })));
        render(<WebpageActionsPanel webpageId="wp1" />);

        expect(await screen.findByText(/No calls to other services found/)).toBeInTheDocument();
        // De grens van de scan staat ZICHTBAAR op het scherm, niet in een
        // tooltip en niet achter een `hidden` — vandaar toBeVisible en niet
        // toBeInTheDocument (een bijttest die hem verborg bleef anders groen).
        expect(screen.getByText(/reading aid, not a security check/)).toBeVisible();
    });

    it('says how many addresses were left out when the list is capped', async () => {
        authFetch.mockResolvedValue(response(clone({
            code: { scanned: true, calls: [CALL], externalCount: 4, unresolved: 0, internal: 0 },
        })));
        render(<WebpageActionsPanel webpageId="wp1" />);
        expect(await screen.findByText('and 3 more addresses not shown')).toBeInTheDocument();
    });

    it('calls it could not resolve are named, not swallowed', async () => {
        authFetch.mockResolvedValue(response(clone({
            code: { scanned: true, calls: [], externalCount: 0, unresolved: 2, internal: 0 },
        })));
        render(<WebpageActionsPanel webpageId="wp1" />);

        expect(await screen.findByText(/2 calls in this page's code could not be checked/)).toBeInTheDocument();
        // …en dan is "niets gevonden" een leugen, dus die regel blijft weg.
        expect(screen.queryByText(/No calls to other services found/)).toBeNull();
    });

});

describe('WebpageActionsPanel — forms, agent and the promoted grants list', () => {
    it('the agent block always says it is signed-in only, and stays silent when unknown', async () => {
        authFetch.mockResolvedValue(response(clone({
            agent: { known: true, agentId: null, supported: false, internalOnly: true },
        })));
        const { unmount } = render(<WebpageActionsPanel webpageId="wp1" />);
        expect(await screen.findByText('No chat block on this page.')).toBeInTheDocument();
        expect(screen.getByText(/A public share never runs it/)).toBeInTheDocument();
        unmount();

        authFetch.mockResolvedValue(response(clone({
            agent: { known: false, agentId: null, supported: false, internalOnly: true },
        })));
        render(<WebpageActionsPanel webpageId="wp1" />);
        expect(await screen.findByText(/could not be checked/)).toBeInTheDocument();
        expect(screen.queryByText('No chat block on this page.')).toBeNull();
    });

    it('somt de blokken op die een automatisering starten, in plaats van te beweren dat ze niet bestaan', async () => {
        // De kaart zei letterlijk "form blocks are not part of this page's
        // building blocks yet" terwijl de Code-tab ernaast een bf-form met
        // bestand en regel tekende — twee panelen in dezelfde tab die elkaar
        // tegenspraken.
        const { unmount } = render(<WebpageActionsPanel webpageId="wp1" />);
        authFetch.mockResolvedValue(response(clone({
            elements: {
                scanned: true, truncated: 0, unknownTags: [], counts: { total: 1, known: 1, unknown: 0 },
                marks: [{ tag: 'bf-form', source: 'index.html', line: 9, known: true, family: 'automation', targetId: 'auto_9', missing: [] }],
            },
            uses: {
                scanned: true, unresolved: [],
                targets: { datatable: [], automation: [{ id: 'auto_9', count: 1, fromPage: false, elements: [] }], agent: [] },
            },
        })));
        unmount();
        render(<WebpageActionsPanel webpageId="wp1" />);
        expect(await screen.findByText('auto_9')).toBeInTheDocument();
        expect(screen.queryByText(/not part of this page's building blocks yet/)).toBeNull();
        // En het scherm zegt erbij wat er bij publiceren met zo'n blok gebeurt.
        expect(screen.getByText(/shown as switched off/)).toBeInTheDocument();
    });

    it('zegt "geen" en "niet gekeken" niet met dezelfde zin', async () => {
        const { unmount } = render(<WebpageActionsPanel webpageId="wp1" />);
        unmount();
        authFetch.mockResolvedValue(response(clone()));
        render(<WebpageActionsPanel webpageId="wp1" />);
        expect(await screen.findByText('This page has no blocks that start an automation.')).toBeInTheDocument();

        authFetch.mockResolvedValue(response(clone({
            forms: { supported: true, scanned: false },
            elements: { scanned: false, marks: [], counts: { total: 0, known: 0, unknown: 0 }, unknownTags: [], truncated: 0 },
        })));
        render(<WebpageActionsPanel webpageId="wp1" />);
        expect(await screen.findByText(/could not be read, so its forms and buttons/)).toBeInTheDocument();
    });

    it('promotes the grants list into this column', async () => {
        authFetch.mockResolvedValue(response(clone()));
        render(<WebpageActionsPanel webpageId="wp1" />);
        expect(await screen.findByTestId('apps-panel')).toHaveTextContent('grants for wp1');
    });

    it('a failed read is not an empty column', async () => {
        authFetch.mockResolvedValue(response({ error: 'nope' }, false, 500));
        render(<WebpageActionsPanel webpageId="wp1" />);
        expect(await screen.findByText('Could not load what this page does.')).toBeInTheDocument();
    });

    it('a non-owner is told so and the owner-only route is never called', async () => {
        render(<WebpageActionsPanel webpageId="wp1" readOnly />);
        expect(await screen.findByText(/Only the page owner can see/)).toBeInTheDocument();
        expect(authFetch).not.toHaveBeenCalled();
    });
});

describe('scaffoldHttpAutomation', () => {
    it('takes the fixed part of a run-time-built address, never the ellipsis', () => {
        const body = scaffoldHttpAutomation({
            ...CALL, url: 'https://api.vendor.com/v1/…', urlPrefix: 'https://api.vendor.com/v1/', dynamic: true,
        });
        expect(body.definition.steps[0].url).toBe('https://api.vendor.com/v1/');
        expect(body.definition.steps[0].url).not.toContain('…');
        // …en de automatisering zegt zelf dat hij nog niet af is.
        expect(body.description).toMatch(/built the rest of the address/);
    });

    it('keeps private targets blocked and carries the method it knew', () => {
        const body = scaffoldHttpAutomation({ ...CALL, kind: 'xhr', method: 'POST' });
        expect(body.definition.steps[0].blockPrivateTargets).toBe(true);
        expect(body.definition.steps[0].method).toBe('POST');
        // Een fetch levert geen methode op; die mag niet verzonnen worden als POST.
        expect(scaffoldHttpAutomation(CALL).definition.steps[0].method).toBe('GET');
    });

    it('wires the one step to the trigger, so the draft is runnable', () => {
        const body = scaffoldHttpAutomation(CALL);
        expect(body.definition.edges).toEqual([{ from: 'trg', to: 'http_1' }]);
        expect(body.definition.trigger.id).toBe('trg');
        expect(automationDeepLink('auto_1')).toBe('studio/automations/auto_1');
    });
});
