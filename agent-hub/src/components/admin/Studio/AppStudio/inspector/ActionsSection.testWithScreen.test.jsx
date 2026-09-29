import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations: vi.fn(async () => ({ automations: [ROUTINE] })) }),
    safeText: vi.fn(async () => ''),
}));

vi.mock('../../../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal()),
    API_BASE: '',
    authFetch: (...args) => authFetch(...args),
}));

import ActionsSection from './ActionsSection';
import { ScreenValuesContext } from '../editor/ScreenValuesContext';

/**
 * "Testen met scherm-invoer" — de testknop naast een Routine-actie.
 *
 * Hij POSTte alleen de STATISCHE waarden uit de mapping. Alles wat aan een
 * formulierveld hing kwam als `undefined` aan, viel uit de JSON, en de routine
 * begon met een lege `trigger.output` — waarna de run er uitzag als een kapotte
 * stap. Twee dingen moeten nu kloppen, en het tweede is niet minder belangrijk
 * dan het eerste:
 *
 *   1. de payload draagt wat er OP DIT MOMENT in het formulier staat;
 *   2. wat niet meegaat — bestandsvelden voorop — staat op het scherm, vóór en
 *      na de klik. Wie test met de helft van de invoer en dat niet weet, trekt
 *      de verkeerde conclusie over de routine.
 *
 * En de uitslag is niet een blok JSON om zelf te ontcijferen: de run gaat open
 * in de builder.
 */

const authFetch = vi.fn();
const ok = (body, status = 200) => ({ ok: true, status, json: async () => body, text: async () => JSON.stringify(body) });

const ROUTINE = {
    id: 'auto-app',
    title: 'Process invoice',
    isActive: true,
    definition: {
        trigger: {
            id: 'trg', kind: 'app_trigger',
            params: [
                { name: 'subject', type: 'string', required: true },
                { name: 'doc', type: 'file', required: true },
                { name: 'ref', type: 'string', required: false },
            ],
        },
        steps: [], edges: [],
    },
};

const FORM = {
    id: 'cmp_form01', type: 'form', props: { name: 'claim' }, style: {},
    onSubmit: 'act_run01',
    children: [
        { id: 'cmp_ttl001', type: 'input_text', props: { name: 'title' }, style: {} },
        { id: 'cmp_upl001', type: 'input_file', props: { name: 'upload', multiple: false }, style: {} },
    ],
};

const ACTIONS = {
    act_run01: {
        kind: 'run_automation',
        automationId: 'auto-app',
        inputMapping: {
            subject: { kind: 'field', name: 'title' },
            doc: { kind: 'field', name: 'upload' },
            ref: { kind: 'field', name: 'renamed' },   // het veld heet inmiddels anders
        },
    },
};

const DEFINITION = {
    schemaVersion: 2,
    meta: { name: 'Expenses' },
    theme: {},
    homeScreenId: 'scr_test1',
    screens: [{
        id: 'scr_test1', name: 'Claim', showInNav: true, maxWidth: 'medium',
        sections: [{ id: 'sec_test1', style: {}, children: [FORM] }],
    }],
    actions: ACTIONS,
};

/** Een schermwaarden-store met vaste inhoud (de echte zit in de canvas). */
function storeWith(values) {
    return {
        publish: vi.fn(),
        read: () => (values ? { claim: values } : {}),
        readForm: (name) => (name === 'claim' ? values : null),
    };
}

function renderActions({ values = undefined, appId = 'app-1', withStore = true } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const section = (
        <ActionsSection node={FORM} definition={DEFINITION} onCommit={vi.fn()} disabled={false} appId={appId} />
    );
    return render(
        <QueryClientProvider client={client}>
            {withStore
                ? <ScreenValuesContext.Provider value={storeWith(values)}>{section}</ScreenValuesContext.Provider>
                : section}
        </QueryClientProvider>,
    );
}

/** Press Test and confirm the "this is a real run" dialog. */
async function pressTest() {
    await userEvent.click(await screen.findByRole('button', { name: /Test with what is on screen/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Run it' }));
}

/** The triggerPayload of the run POST, parsed. */
function sentPayload() {
    const call = authFetch.mock.calls.find(([url, init]) => init?.method === 'POST' && String(url).includes('/run'));
    expect(call, 'the routine was never run').toBeTruthy();
    return JSON.parse(call[1].body).triggerPayload;
}

beforeEach(() => {
    cleanup();
    authFetch.mockReset();
    authFetch.mockImplementation(async (url, init) => {
        if (init?.method === 'POST') return ok({ accepted: true, run: { id: 'run_1', status: 'success' }, steps: [] });
        return ok({});
    });
    vi.stubGlobal('open', vi.fn(() => ({})));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('de payload draagt wat er op het scherm staat', () => {
    it('stuurt de LIVE veldwaarde mee, niet alleen de statische waarden', async () => {
        renderActions({ values: { title: 'Typed just now', upload: { kind: 'studio_attachment', fileId: 'f1' } } });
        await pressTest();
        await waitFor(() => expect(sentPayload()).toEqual({ subject: 'Typed just now' }));
    });

    it('stuurt het bestandsveld NIET mee, hoe gevuld het scherm ook is', async () => {
        // De browser heeft alleen een descriptor, en alleen de app-brug kan die
        // uitpakken — deze route niet. Meesturen zou een halve waarheid zijn.
        renderActions({ values: { title: 'x', upload: { kind: 'studio_attachment', fileId: 'f1' } } });
        await pressTest();
        await waitFor(() => expect(sentPayload()).not.toHaveProperty('doc'));
    });

    it('verzint niets zonder schermwaarden — en stuurt dan ook geen lege string', async () => {
        renderActions({ withStore: false });
        await pressTest();
        await waitFor(() => expect(sentPayload()).toEqual({}));
    });
});

describe('wat niet meegaat wordt gezegd, niet verzwegen', () => {
    it('noemt het bestandsveld al vóór de klik', async () => {
        renderActions({ values: { title: 'x' } });
        expect(await screen.findByText(/doc \(upload\) — a file cannot be sent from here/i)).toBeTruthy();
    });

    it('noemt na de run ook wat op dat moment ontbrak', async () => {
        // `ref` wijst naar een veld dat het formulier niet meer heeft. Zonder
        // melding komt dat aan als "de stap doet niets".
        renderActions({ values: { title: 'x' } });
        await pressTest();
        expect(await screen.findByText(/ref \(renamed\) — the form has no field by that name/i)).toBeTruthy();
    });

    it('zegt het ook als het formulier helemaal niet op het scherm staat', async () => {
        renderActions({ withStore: false });
        await pressTest();
        expect(await screen.findByText(/subject \(title\) — that form is not on the canvas/i)).toBeTruthy();
    });

    it('vertelt na een MISLUKTE run nog steeds wat er niet in zat', async () => {
        // Juist dan: wat ontbrak is vaak de reden dat hij faalde.
        authFetch.mockImplementation(async (url, init) => (init?.method === 'POST'
            ? { ok: false, status: 500, json: async () => ({ error: 'boom' }), text: async () => 'boom' }
            : ok({})));
        renderActions({ values: { title: 'x' } });
        await pressTest();
        expect(await screen.findByText('Test failed')).toBeTruthy();
        expect(screen.getByText(/ref \(renamed\) — the form has no field by that name/i)).toBeTruthy();
    });
});

describe('de uitslag gaat open in de builder', () => {
    it('opent de RUN, met de weg terug naar deze knop erin', async () => {
        renderActions({ values: { title: 'x' } });
        await pressTest();
        await waitFor(() => expect(window.open).toHaveBeenCalledWith(
            '/app/studio/automations/auto-app?view=runs&run=run_1&from=app%3Aapp-1%3Ascr_test1%3Acmp_form01',
            '_blank',
            'noopener,noreferrer',
        ));
    });

    it('laat de link ook op het scherm staan, want een pop-up mag geblokkeerd worden', async () => {
        vi.stubGlobal('open', vi.fn(() => null));
        const { container } = renderActions({ values: { title: 'x' } });
        await pressTest();
        await waitFor(() => expect(container.querySelector('a[href*="run=run_1"]')).toBeTruthy());
        expect(screen.getByText('Open this run in the builder')).toBeTruthy();
    });

    it('claimt geen run-id dat er niet is (202: nog bezig)', async () => {
        authFetch.mockImplementation(async (url, init) => (init?.method === 'POST'
            ? ok({ accepted: true, pending: true, message: 'Run is still in progress.' }, 202)
            : ok({})));
        const { container } = renderActions({ values: { title: 'x' } });
        await pressTest();
        await waitFor(() => expect(screen.getByText(/Open this routine’s runs in the builder/)).toBeTruthy());
        expect(container.querySelector('a[href*="run="]')).toBeNull();
    });
});
