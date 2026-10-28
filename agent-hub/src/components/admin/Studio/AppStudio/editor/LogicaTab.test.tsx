import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

// The routine list normally comes from one shared request per session (editor/automationTitles.js).
// Here it is data, so that each test can set up its own solution and steps without having to time a fetch.
const AUTOMATION_ROWS = { current: {} };
vi.mock('./automationTitles', () => ({
    useAutomationRows: () => AUTOMATION_ROWS.current,
    useAutomationTitles: () => ({}),
}));

// AutomationPicker itself stays REAL — the assignment is that "+ Add an automation" opens the EXISTING
// picker and that no second one appears, and you can only see that by letting it render. Only its data
// layer is a stub.
const listAutomations = vi.fn(async () => ({ automations: [{ id: 'aut_new', title: 'Weekly digest', isActive: true }] }));
vi.mock('@/hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations, createAutomation: vi.fn() }),
}));

import LogicaTab, { pendingCountOf, runCountOf } from './LogicaTab';
import { authFetch } from '@/utils/helpers';
import { asMock, stub } from '@/test/mocks';
import type { ReactNode } from 'react';
import type { ComponentProps } from 'react';

/**
 * The status column is where this screen can start lying: both counts are scoped to the viewer, and both
 * can fail. "0" and "I was not allowed to look" must therefore produce different things on screen, and the
 * sentence must say WHAT is being counted (24 hours, by you) instead of "today".
 */

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const denied = (status = 403) => ({ ok: false, status, json: async () => ({ error: 'nope' }) });

/** Routes de fetch op URL; alles wat niet genoemd is faalt hard. */
function routeFetch({ runs, approvals }: { runs?: unknown; approvals?: unknown }) {
    asMock(authFetch).mockImplementation(async (url: string) => {
        if (String(url).includes('/_runs/facets')) return runs;
        if (String(url).includes('/approvals/facets')) return approvals;
        throw new Error(`unexpected fetch: ${url}`);
    });
}

const APP = { id: 'app_1', projectId: 'prj_1' };

function definitionWith(children: ReactNode, actions = {}) {
    return {
        screens: [{ id: 'scr_1', name: 'Orders', sections: [{ id: 'sec_1', children }] }],
        actions,
    };
}

function renderTab(props = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const utils = render(
        <QueryClientProvider client={client}>
            <LogicaTab app={APP} definition={stub<ComponentProps<typeof LogicaTab>['definition']>(definitionWith([]))} {...props} />
        </QueryClientProvider>,
    );
    return { ...utils, client };
}

/** Wacht tot een react-query-sleutel écht klaar is — anders is elke negatieve assertie leeg. */
async function settled(client: QueryClient, key: string) {
    await waitFor(() => {
        const state = client.getQueryState(stub<Parameters<typeof client.getQueryState>[0]>(key));
        expect(state?.status, `${key} is nooit gesetteld`).not.toBe('pending');
        expect(state?.fetchStatus).toBe('idle');
    });
}

beforeEach(() => {
    asMock(authFetch).mockReset();
    AUTOMATION_ROWS.current = {};
    routeFetch({ runs: ok({ facets: { automationId: {} } }), approvals: ok({ facets: { status: {} } }) });
});

describe('een event zonder actie verdwijnt niet', () => {
    it('krijgt een gestippelde "no action yet"-rij in plaats van niets', async () => {
        renderTab({
            definition: definitionWith(stub<Parameters<typeof definitionWith>[0]>([
                { id: 'nd_grid', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' } } },
            ])),
        });
        const unwired = document.querySelectorAll('[data-logic-wired="false"]');
        expect(unwired.length).toBe(2); // onRowClick + onRowSelect
        expect(screen.getAllByText('No action yet').length).toBe(2);
        expect(screen.getByText('When a row is clicked')).toBeInTheDocument();
        expect(screen.getByText('When a row is selected')).toBeInTheDocument();
    });

    it('hangt de save-melding van de server aan de rij waar hij over gaat', async () => {
        renderTab({
            definition: definitionWith(stub<Parameters<typeof definitionWith>[0]>([{ id: 'nd_b', type: 'button', props: { text: 'Go' } }])),
            saveNotices: {
                warnings: [{
                    code: 'component.control_inert',
                    path: 'screens[0].sections[0].children[0]',
                    message: 'This button is wired to nothing — clicking it does nothing at all.',
                }],
            },
        });
        const row = document.querySelector('[data-logic-wired="false"]');
        expect(within((row as HTMLElement)).getByText(/wired to nothing/)).toBeInTheDocument();
        expect(row!.querySelectorAll('[data-logic-notice="warning"]').length).toBe(1);
    });

    it('zet een app-brede melding niet op een willekeurige rij', async () => {
        renderTab({
            definition: definitionWith(stub<Parameters<typeof definitionWith>[0]>([{ id: 'nd_b', type: 'button', props: { text: 'Go' } }])),
            saveNotices: { warnings: [{ code: 'meta.name', path: 'meta.name', message: 'The name is empty.' }] },
        });
        expect(screen.queryByText('The name is empty.')).not.toBeInTheDocument();
    });
});

describe('de statuskolom telt niet wat ze niet heeft', () => {
    const wiredToAutomation = () => definitionWith(
        stub<Parameters<typeof definitionWith>[0]>([{ id: 'nd_b', type: 'button', onClick: 'act_run' }]),
        { act_run: { kind: 'run_automation', automationId: 'aut_7' } },
    );

    it('zegt over welk venster en wiens runs het gaat — nooit "vandaag"', async () => {
        routeFetch({
            runs: ok({ facets: { automationId: { aut_7: 38 } } }),
            approvals: ok({ facets: { status: {} } }),
        });
        const { client } = renderTab({ definition: wiredToAutomation() });
        await settled(client, stub<Parameters<typeof settled>[1]>(['studio-app-logic-runs', 'app_1']));
        expect(await screen.findByText('38 runs by you in the last 24 hours')).toBeInTheDocument();
        expect(screen.queryByText(/today/i)).not.toBeInTheDocument();
    });

    it('gebruikt het enkelvoud via de sleutel, niet via een "(s)" in de zin', async () => {
        routeFetch({
            runs: ok({ facets: { automationId: { aut_7: 1 } } }),
            approvals: ok({ facets: { status: {} } }),
        });
        const { client } = renderTab({ definition: wiredToAutomation() });
        await settled(client, stub<Parameters<typeof settled>[1]>(['studio-app-logic-runs', 'app_1']));
        expect(await screen.findByText('1 run by you in the last 24 hours')).toBeInTheDocument();
    });

    it('schrijft "Not available" — geen 0 — als de runs niet gelezen konden worden', async () => {
        routeFetch({ runs: denied(500), approvals: ok({ facets: { status: {} } }) });
        const { client } = renderTab({ definition: wiredToAutomation() });
        await settled(client, stub<Parameters<typeof settled>[1]>(['studio-app-logic-runs', 'app_1']));
        const cell = await waitFor(() => {
            const el = document.querySelector('[data-logic-status="unknown"]');
            expect(el, 'de statuskolom bleef niet op onbekend staan').toBeTruthy();
            return el;
        });
        expect(cell).toHaveTextContent('Not available');
        expect(screen.queryByText(/^0 runs/)).not.toBeInTheDocument();
    });

    it('telt wachtende beslissingen kijkergescoopt, en vraagt scope=mine', async () => {
        routeFetch({
            runs: ok({ facets: { automationId: {} } }),
            approvals: ok({ facets: { status: { pending: 1 } } }),
        });
        const { client } = renderTab({
            definition: definitionWith(stub<Parameters<typeof definitionWith>[0]>([{ id: 'nd_ap', type: 'approval_list', props: {} }])),
        });
        await settled(client, stub<Parameters<typeof settled>[1]>(['studio-app-logic-approvals', 'app_1']));
        expect(await screen.findByText('1 decision waiting for you')).toBeInTheDocument();
        const url = asMock(authFetch).mock.calls.map(([u]) => String(u)).find((u) => u.includes('/approvals/facets'));
        expect(url).toContain('scope=mine');
        expect(url).toContain('appId=app_1');
    });

    it('degradeert een 403 van de approvals-licentiepoort naar onbekend, niet naar 0', async () => {
        routeFetch({ runs: ok({ facets: { automationId: {} } }), approvals: denied(403) });
        const { client } = renderTab({
            definition: definitionWith(stub<Parameters<typeof definitionWith>[0]>([{ id: 'nd_ap', type: 'approval_list', props: {} }])),
        });
        await settled(client, stub<Parameters<typeof settled>[1]>(['studio-app-logic-approvals', 'app_1']));
        expect(await screen.findByText('Not available')).toBeInTheDocument();
        expect(screen.queryByText(/^0 decisions/)).not.toBeInTheDocument();
    });

    it('vraagt de org-brede runs-endpoint nooit aan', async () => {
        const { client } = renderTab({ definition: wiredToAutomation() });
        await settled(client, stub<Parameters<typeof settled>[1]>(['studio-app-logic-runs', 'app_1']));
        for (const [url] of asMock(authFetch).mock.calls) {
            expect(String(url)).not.toContain('/_runs/org');
        }
    });
});

describe('runCountOf / pendingCountOf — null en 0 zijn verschillende antwoorden', () => {
    it('geeft null als er niets gelezen is, en 0 als de lezing leeg was', () => {
        expect(runCountOf(null, 'aut_1')).toBeNull();
        expect(runCountOf({}, 'aut_1')).toBeNull();
        expect(runCountOf({ automationId: {} }, 'aut_1')).toBe(0);
        expect(runCountOf({ automationId: { aut_1: 4 } }, 'aut_1')).toBe(4);

        expect(pendingCountOf(null)).toBeNull();
        expect(pendingCountOf({})).toBeNull();
        expect(pendingCountOf({ status: {} })).toBe(0);
        expect(pendingCountOf({ status: { pending: 2 } })).toBe(2);
    });
});

describe('"+ Add an automation" opent de bestaande kiezer', () => {
    it('rendert AutomationPicker en commit de gekozen automatisering als losse actie', async () => {
        const user = userEvent.setup();
        const onCommit = vi.fn();
        renderTab({ definition: definitionWith([]), onCommit });

        await user.click(screen.getByRole('button', { name: 'Add an automation' }));

        // De echte AutomationPicker: eigen zoekveld, eigen lijst, eigen titel.
        expect(await screen.findByRole('dialog', { name: /Choose an automation/i })).toBeInTheDocument();
        expect(screen.getByLabelText('Search automations')).toBeInTheDocument();
        expect(listAutomations).toHaveBeenCalled();

        await user.click(await screen.findByText('Weekly digest'));
        expect(onCommit).toHaveBeenCalledTimes(1);
        const next = onCommit.mock.calls[0][0];
        const added = Object.values(next.actions);
        expect(added).toEqual([{ kind: 'run_automation', automationId: 'aut_new' }]);
    });

    it('laat een actie waar niets naar wijst als gestippelde rij zien', async () => {
        renderTab({
            definition: definitionWith([], { act_lost: { kind: 'run_automation', automationId: 'aut_9' } }),
        });
        const row = document.querySelector('[data-logic-row="orphan_action"]');
        expect(row).toBeTruthy();
        expect(row!.getAttribute('data-logic-wired')).toBe('false');
        expect(within((row as HTMLElement)).getByText('Nothing starts this yet')).toBeInTheDocument();
    });
});

describe('Automations van deze app — afgeleid, en alleen als beide dingen kloppen', () => {
    beforeEach(() => {
        AUTOMATION_ROWS.current = {
            aut_night: {
                id: 'aut_night', title: 'Nightly reminder', projectId: 'prj_1',
                definition: { trigger: { kind: 'schedule' }, steps: [{ datatableId: 'tbl_a' }] },
            },
            aut_else: {
                id: 'aut_else', title: 'Other solution', projectId: 'prj_9',
                definition: { steps: [{ datatableId: 'tbl_a' }] },
            },
        };
    });

    const boundDef = () => definitionWith(stub<Parameters<typeof definitionWith>[0]>([
        { id: 'nd_grid', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' } } },
    ]));

    it('toont de automatisering uit dezelfde oplossing die de gebonden tabel raakt', async () => {
        renderTab({ definition: boundDef() });
        const section = document.querySelector('[data-logic-automations]');
        expect(section).toBeTruthy();
        expect(within((section as HTMLElement)).getByText('Nightly reminder')).toBeInTheDocument();
        expect(within((section as HTMLElement)).getByText('On a schedule')).toBeInTheDocument();
        expect(within((section as HTMLElement)).queryByText('Other solution')).not.toBeInTheDocument();
    });

    it('toont niets voor een app die in geen oplossing staat', async () => {
        renderTab({ app: { id: 'app_1', projectId: null }, definition: boundDef() });
        expect(document.querySelector('[data-logic-automations]')).toBeNull();
    });

    it('zegt in de kop dat het JOUW automatiseringen zijn — de lijst is kijkergescoopt', async () => {
        // The rows come from GET /api/automation → getAutomationsForUser (`WHERE user_id = $1`). A colleague's
        // nightly automation, in the same solution and on the same table, is not in them — and an empty section
        // is not distinguishable from "there are none". Narrowing is allowed; putting "Automations in this
        // solution" above it is not.
        renderTab({ definition: boundDef() });
        const section = document.querySelector('[data-logic-automations]');
        expect(within((section as HTMLElement)).getByText('Your automations in this solution')).toBeInTheDocument();
        expect(within((section as HTMLElement)).getByText(/Automations owned by someone else are not listed/))
            .toBeInTheDocument();
    });

    it('ontdubbelt: een automatisering die al aan een knop hangt komt er niet nóg eens bij', async () => {
        // Without `wiredAutomationIds` the same automation would appear twice on screen — once at the button, once
        // in this section.
        const def = definitionWith(stub<Parameters<typeof definitionWith>[0]>([
            { id: 'nd_grid', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' } } },
            { id: 'nd_b', type: 'button', props: { text: 'Run' }, onClick: 'act_run' },
        ]));
        def.actions = { ...def.actions, act_run: { kind: 'run_automation', automationId: 'aut_night' } };
        renderTab({ definition: def });
        expect(screen.getAllByText(/Nightly reminder/)).toHaveLength(1);
        expect(document.querySelector('[data-logic-automations]')).toBeNull();
    });
});

describe('de ↗-kolom', () => {
    it('brengt je naar het component op het canvas', async () => {
        const user = userEvent.setup();
        const onReveal = vi.fn();
        renderTab({
            definition: definitionWith(stub<Parameters<typeof definitionWith>[0]>([{ id: 'nd_b', type: 'button', props: { text: 'Go' } }])),
            onReveal,
        });
        await user.click(screen.getByRole('button', { name: 'Show me' }));
        expect(onReveal).toHaveBeenCalledWith({ screenId: 'scr_1', nodeId: 'nd_b' });
    });

    it('linkt een automatisering zonder component naar de Automations-builder', async () => {
        AUTOMATION_ROWS.current = {
            aut_night: {
                id: 'aut_night', title: 'Nightly reminder', projectId: 'prj_1',
                definition: { trigger: { kind: 'schedule' }, steps: [{ datatableId: 'tbl_a' }] },
            },
        };
        renderTab({
            definition: definitionWith(stub<Parameters<typeof definitionWith>[0]>([
                { id: 'nd_grid', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' } } },
            ])),
        });
        const section = document.querySelector('[data-logic-automations]');
        expect(within((section as HTMLElement)).getByRole('link', { name: 'Open' }))
            .toHaveAttribute('href', '/app/studio/automations/aut_night');
    });
});

describe('de lege staat', () => {
    it('zegt wat je kunt doen in plaats van een lege tabel te tekenen', async () => {
        renderTab({ definition: definitionWith([]) });
        expect(document.querySelector('[data-logic-table]')).toBeNull();
        expect(screen.getByText(/Nothing is wired yet/)).toBeInTheDocument();
    });
});
