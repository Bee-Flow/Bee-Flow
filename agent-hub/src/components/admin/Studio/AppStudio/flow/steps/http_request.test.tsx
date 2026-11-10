import { createRequire } from 'node:module';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import { EditorChromeContext } from '@/components/admin/Studio/AppStudio/editor/EditorChromeContext';
import StepSettings from '../StepSettings';
import { newStep, paletteGroups, stepMeta } from '../stepKinds';
import type { AppAction, AppDefinition } from '@/components/admin/Studio/AppStudio/inspector/appDefinition';

/**
 * The "Call a web service" step in the step editor, against the real step catalog and the real
 * canonicalizer and validator: the step the palette drops is valid once a connection is picked,
 * the picker offers REST connections only, and what an edit writes is what canonicalize keeps.
 */

const require = createRequire(import.meta.url);
const SERVER = path.resolve(__dirname, '../../../../../../../../server');
const { canonicalizeAppDefinition } = require(path.join(SERVER, 'appStudio/canonicalize.js'));
const { validateAppDefinition } = require(path.join(SERVER, 'appStudio/validate.js'));
const { STEP_SPECS } = require(path.join(SERVER, 'appStudio/componentSpecs.js'));

type Step = AppAction & Record<string, unknown>;

const CONNECTORS = [
    { id: 'conn_ab12cd', kind: 'rest', name: 'Order service', params: [] },
    { id: 'conn_mail01', kind: 'mailbox', name: 'Support inbox', params: [] },
    { id: 'conn_tool01', kind: 'integration_tool', name: 'Calendar', params: [] },
];
const MODEL = { tables: [], connectors: [{ id: 'conn_ab12cd', kind: 'rest', url: 'https://api.example.test/v1' }, { id: 'conn_mail01', kind: 'mailbox', provider: 'gmail' }] };

const DEFINITION = {
    schemaVersion: 2, meta: { name: 'T' }, theme: {}, homeScreenId: 'scr_a00001',
    screens: [{ id: 'scr_a00001', name: 'T', sections: [] }], actions: {},
} as unknown as AppDefinition;

function answer(url: string): unknown {
    if (url.includes('/studio-apps/catalog')) return { components: {}, actions: { stepSpecs: STEP_SPECS } };
    if (url.includes('/data/connectors')) return { connectors: CONNECTORS };
    if (url.includes('/data/tables')) return { tables: [] };
    return {};
}

beforeEach(() => { setDemoTransport(async (url: string) => new Response(JSON.stringify(answer(String(url))), { status: 200, headers: { 'Content-Type': 'application/json' } })); });
afterEach(() => { setDemoTransport(null); });

/** The step as canonicalize stores it, and what the validator says about it at publish. */
function stored(step: Step): { step: Step; errors: string[] } {
    const def = { ...JSON.parse(JSON.stringify(DEFINITION)), actions: { act_probe: { kind: 'sequence', steps: [step] } } };
    const canonical = canonicalizeAppDefinition(def).def;
    const errors = (validateAppDefinition(canonical, { dataModel: MODEL }).errors as Array<{ code: string; path: string }>)
        .filter((e) => e.path.startsWith('actions.act_probe.steps')).map((e) => e.code);
    return { step: canonical.actions.act_probe.steps[0], errors };
}

function mount(initial: Step) {
    const writes: Step[] = [];
    function Harness() {
        const [step, setStep] = useState(initial);
        return <StepSettings step={step} onChange={(next) => { writes.push(next as Step); setStep(next as Step); }} definition={DEFINITION} />;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><EditorChromeContext.Provider value={{ appId: 'app-1' }}><Harness /></EditorChromeContext.Provider></QueryClientProvider>);
    return { ...view, writes, last: () => writes.at(-1) as Step };
}

describe('http_request in the step editor', () => {
    it('is offered in the palette under Data, as a server step', () => {
        const data = paletteGroups().find((g) => g.group === 'Data');
        expect(data?.kinds.map((k) => k.kind)).toContain('http_request');
        expect(stepMeta('http_request')).toMatchObject({ label: 'Call a web service', server: true });
    });

    it('a fresh step is what canonicalize keeps, and only lacks its connection', () => {
        const fresh = newStep('http_request') as Step;
        expect(fresh).toEqual({ kind: 'http_request', connectorId: '', method: 'GET', path: '/' });
        expect(stored(fresh).step).toEqual({ ...fresh, bodyFormat: 'json', expect: 'json' });
        expect(stored(fresh).errors).toEqual(['action.http_connector_invalid']);
        expect(stored({ ...fresh, connectorId: 'conn_ab12cd' }).errors).toEqual([]);
    });

    it('the connection picker offers the REST connections of the app and no other kind', async () => {
        const user = userEvent.setup();
        const view = mount(newStep('http_request') as Step);
        const picker = await screen.findByRole('combobox', { name: 'Connection' }) as HTMLSelectElement;
        await waitFor(() => expect(within(picker).queryByRole('option', { name: 'Order service' })).not.toBeNull());
        expect([...picker.options].map((o) => o.textContent)).toEqual(['Pick a connection…', 'Order service']);
        await user.selectOptions(picker, 'conn_ab12cd');
        expect(view.last().connectorId).toBe('conn_ab12cd');
        expect(stored(view.last()).errors).toEqual([]);
    });

    it('a step that names a connection of another kind shows it as missing', async () => {
        mount({ ...(newStep('http_request') as Step), connectorId: 'conn_mail01' });
        const picker = await screen.findByRole('combobox', { name: 'Connection' }) as HTMLSelectElement;
        await waitFor(() => expect(picker.options.length).toBe(3));
        expect(picker.getAttribute('aria-invalid')).toBe('true');
    });

    it('has a control for every field, with its own labels and hints, and no text box over structured data', async () => {
        const full: Step = {
            kind: 'http_request', connectorId: 'conn_ab12cd', method: 'POST', path: '/v1/orders/{{form.orderId}}/notes',
            query: { region: { kind: 'formula', expr: 'vars.region' } }, headers: { 'X-Trace': { kind: 'static', value: 'on' } },
            body: { kind: 'static', value: '{"text": "{{form.note}}"}' }, bodyFormat: 'json', expect: 'json',
            idempotencyKey: { kind: 'formula', expr: 'form.orderId' }, resultVar: 'note',
        };
        const { container, writes } = mount(full);
        await screen.findByRole('combobox', { name: 'Connection' });
        for (const label of ['Method', 'Path', 'Query parameters', 'Extra headers', 'Body', 'Body format', 'Read the answer as', 'Idempotency key']) {
            expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
        }
        expect(screen.getByText(/The path on the connection’s host/)).not.toBeNull();
        expect(screen.getByText(/A value that names this one write/)).not.toBeNull();
        expect((screen.getByRole('combobox', { name: 'Method' }) as HTMLSelectElement).value).toBe('POST');
        expect((screen.getByRole('textbox', { name: 'Path' }) as HTMLInputElement).value).toBe('/v1/orders/{{form.orderId}}/notes');
        const boxes = [...container.querySelectorAll('input, textarea')] as HTMLInputElement[];
        expect(boxes.filter((b) => b.value.includes('[object Object]'))).toEqual([]);
        expect(writes).toEqual([]);
        expect(stored(full).step).toEqual(full);
        expect(stored(full).errors).toEqual([]);
    });

    it('editing the method and the path writes what canonicalize keeps', async () => {
        const user = userEvent.setup();
        const view = mount({ ...(newStep('http_request') as Step), connectorId: 'conn_ab12cd' });
        await user.selectOptions(await screen.findByRole('combobox', { name: 'Method' }), 'DELETE');
        expect(view.last().method).toBe('DELETE');
        const pathBox = screen.getByRole('textbox', { name: 'Path' });
        await user.type(pathBox, 'v1/orders');
        expect(view.last().path).toBe('/v1/orders');
        const kept = stored(view.last());
        expect(kept.step).toEqual({ ...view.last(), bodyFormat: 'json', expect: 'json' });
        expect(kept.errors).toEqual([]);
    });
});
