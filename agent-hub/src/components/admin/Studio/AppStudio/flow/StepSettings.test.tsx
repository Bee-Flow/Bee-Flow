import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { authFetch } from '@/utils/helpers';
import StepSettings from './StepSettings';
import { EditorChromeContext } from '../editor/EditorChromeContext';
import { asMock, stub } from '@/test/mocks';
import type { ComponentProps } from 'react';

/**
 * A reference is a PICK, never a typed id.
 *
 * The server types every reference field as a plain `string`, so the spec-driven
 * panel rendered five of the six as free text: "Add a row" asked for a table id,
 * "Open a dialog" for a node id, "Run automation" for a uuid. Only `screenId` had
 * been special-cased. These pin that each one is a picker sourced from the app
 * itself — and that a reference whose target is GONE keeps its id and says so
 * rather than quietly blanking.
 */

const STEP_SPECS_STUB = {
    create_record: {
        fields: {
            tableId: { type: 'string', required: true },
            values: { type: 'recordValues', required: true },
        },
    },
    open_modal: { fields: { modalId: { type: 'string', required: true } } },
    toast: { fields: {
        message: { type: 'string', required: true, maxLen: 500 },
        tone: { type: 'enum', values: ['info', 'success'], default: 'info' },
        messageExpr: { type: 'formula', since: 3 },
    } },
    open_url: { fields: { url: { type: 'url', required: true }, newTab: { type: 'boolean', default: true }, urlExpr: { type: 'formula', since: 3 } } },
    switch: { fields: { expr: { type: 'formula', required: true }, cases: { type: 'switchCases', required: true }, default: { type: 'steps' } } },
    delete_record: {
        fields: {
            tableId: { type: 'string', required: true },
            recordId: { type: 'binding' },
            filter: { type: 'recordFilter' },
            limit: { type: 'int', min: 1, max: 500 },
            resultVar: { type: 'string', maxLen: 60 },
        },
    },
    run_automation: {
        fields: {
            automationId: { type: 'string', nullable: true, required: true },
            inputMapping: { type: 'inputMapping' },
            resultVar: { type: 'string', maxLen: 60 },
            guard: { type: 'formula', since: 3 },
        },
    },
    refresh: {
        fields: {
            tableId: { type: 'string' },
            datasetId: { type: 'string' },
            actionId: { type: 'string' },   // deprecated, ignored by the runtime
        },
    },
    navigate: { fields: { screenId: { type: 'string', required: true }, params: { type: 'navParams' } } },
    call_action: { fields: { actionId: { type: 'string', required: true, maxLen: 80 }, params: { type: 'callParams' }, resultVar: { type: 'string', maxLen: 60 } } },
    ai_generate: { fields: {
        prompt: { type: 'string', required: true }, modelTier: { type: 'tierChoice', maxLen: 60 },
        retry: { type: 'retry', envelope: true }, onError: { type: 'errorHandler', envelope: true },
    } },
};

vi.mock('../studioAppsApi', () => ({
    studioAppsApi: { getCatalog: vi.fn(async () => ({ components: {}, actions: { stepSpecs: STEP_SPECS_STUB } })) },
}));

vi.mock('@/utils/helpers', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, authFetch: vi.fn() };
});

const listAutomations = vi.fn(async () => ({
    automations: [{ id: 'auto-1', title: 'Send the invoice' }, { id: 'auto-2', title: 'Chase the payment' }],
}));
vi.mock('@/hooks/useAutomationApi', () => ({ default: () => ({ listAutomations }) }));

const TABLES = [
    { id: 'tbl_inv', key: 'invoices', name: 'Invoices', fields: [
        { id: 'f1', key: 'customer', name: 'Customer', type: 'text', required: true },
        { id: 'f2', key: 'amount_due', name: 'Amount due', type: 'number' },
    ] },
    { id: 'tbl_cus', key: 'customers', name: 'Customers', fields: [] },
];

const DEFINITION = {
    schemaVersion: 2,
    meta: { name: 'T' },
    homeScreenId: 'scr_a',
    screens: [
        { id: 'scr_a', name: 'List', sections: [{ id: 'sec_a', children: [
            { id: 'nd_modal', type: 'modal', props: { title: 'Confirm delete' }, children: [] },
            { id: 'nd_modal2', type: 'modal', props: {}, children: [] },
        ] }] },
        { id: 'scr_b', name: 'Detail', sections: [{ id: 'sec_b', children: [] }] },
    ],
    actions: {},
};

function jsonRes(body: unknown) {
    return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
    vi.clearAllMocks();
    asMock(authFetch).mockImplementation(async (url: string) => {
        if (String(url).includes('/data/tables')) return jsonRes({ tables: TABLES });
        if (String(url).includes('/data/connectors')) return jsonRes({ connectors: [{ id: 'con_mail', name: 'Support mailbox' }] });
        if (String(url).includes('/datasets')) return jsonRes({ datasets: [{ id: 'ds_1', name: 'Overdue invoices' }] });
        return jsonRes({});
    });
});

function renderStep(step: ComponentProps<typeof StepSettings>['step'], { appId = 'app-1' } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onChange = vi.fn();
    const utils = render(
        <QueryClientProvider client={client}>
            <EditorChromeContext.Provider value={appId ? { appId } : null}>
                <StepSettings
                    step={step}
                    onChange={onChange}
                    definition={DEFINITION}
                    screens={DEFINITION.screens}
                />
            </EditorChromeContext.Provider>
        </QueryClientProvider>,
    );
    return { onChange, last: () => onChange.mock.calls.at(-1)?.[0], ...utils };
}

/** Option texts of a <select>, minus its placeholder row. */
const optionsOf = (el: HTMLElement) => [...(el as HTMLSelectElement).options].map((o) => o.textContent);

describe('StepSettings — a reference is picked, never typed', () => {
    it('offers the app’s tables by name instead of a table id box', async () => {
        renderStep({ kind: 'create_record', tableId: '', values: {} });
        const control = await screen.findByLabelText('Table');
        expect(control.tagName).toBe('SELECT');
        expect(optionsOf(control)).toEqual(expect.arrayContaining(['Invoices', 'Customers']));
    });

    it('offers the app’s dialogs by their title', async () => {
        renderStep({ kind: 'open_modal', modalId: '' });
        const control = await screen.findByLabelText('Dialog');
        expect(control.tagName).toBe('SELECT');
        // A dialog with a title is named by it; one without falls back to its id
        // so it is still tellable apart.
        expect(optionsOf(control)).toEqual(expect.arrayContaining(['Confirm delete', 'nd_modal2']));
    });

    it('names the automation rather than showing its id', async () => {
        renderStep({ kind: 'run_automation', automationId: 'auto-2' });
        const control = await screen.findByLabelText('Automation');
        await waitFor(() => expect(control.textContent).toContain('Chase the payment'));
        // Not a text box: the id is never something to type.
        expect(control.tagName).toBe('BUTTON');
    });

    it('offers saved views for a narrowed refresh', async () => {
        renderStep({ kind: 'refresh', datasetId: '' });
        const control = await screen.findByLabelText('Saved view');
        expect(optionsOf(control)).toEqual(expect.arrayContaining(['Overdue invoices']));
    });

    it('keeps the screen picker it already had', async () => {
        renderStep({ kind: 'navigate', screenId: 'scr_b' });
        const control = await screen.findByLabelText('Screen');
        expect(control.tagName).toBe('SELECT');
        expect(optionsOf(control)).toContain('Detail');
    });
});

describe('StepSettings — a reference whose target is gone', () => {
    it('keeps the id and says it is missing, rather than blanking it', async () => {
        renderStep({ kind: 'create_record', tableId: 'tbl_deleted', values: {} });
        const control = await screen.findByLabelText('Table');
        // The value survives, so the person can see what the step used to do.
        await waitFor(() => expect((control as HTMLInputElement).value).toBe('tbl_deleted'));
        expect(await screen.findByText(/no longer exists/i)).toBeTruthy();
        expect(control.getAttribute('aria-invalid')).toBe('true');
    });

    it('says nothing while the list has not loaded yet', () => {
        // appId null → no lists at all. An unknown id here is "not known yet",
        // never "broken" — warning on it would cry wolf on every mount.
        renderStep({ kind: 'create_record', tableId: 'tbl_inv', values: {} }, stub<Parameters<typeof renderStep>[1]>({ appId: null }));
        expect(screen.queryByText(/no longer exists/i)).toBeNull();
    });
});

describe('StepSettings — the values a row is written with', () => {
    it('offers the chosen table’s columns instead of asking for a spelling', async () => {
        renderStep({ kind: 'create_record', tableId: 'tbl_inv', values: { customer: { kind: 'static', value: 'x' } } });
        const control = await screen.findByLabelText('Values 1 name');
        await waitFor(() => expect(control.tagName).toBe('SELECT'));
        expect(optionsOf(control)).toEqual(expect.arrayContaining(['Customer *', 'Amount due']));
    });

    it('falls back to a typed name when the table is not known', async () => {
        renderStep({ kind: 'create_record', tableId: '', values: { whatever: { kind: 'static', value: 'x' } } });
        const control = await screen.findByLabelText('Values 1 name');
        expect(control.tagName).toBe('INPUT');
    });
});

describe('StepSettings — fields the runtime ignores', () => {
    it('does not render an editor for refresh.actionId', async () => {
        renderStep({ kind: 'refresh' });
        // The two live fields are there…
        expect(await screen.findByLabelText('Table')).toBeTruthy();
        // …and the deprecated one, which the runtime has always ignored, is not
        // offered as something to fill in.
        expect(screen.queryByLabelText('Action')).toBeNull();
    });
});

/**
 * The stored shape is an OBJECT keyed by name, so two rows cannot share one.
 * Resolving that with a plain Object.fromEntries — which is what this did —
 * keeps the last row and throws the other away without a word.
 */
describe('StepSettings — a map of name → value cannot silently eat a row', () => {
    it('does not commit a second blank row over the first', async () => {
        const user = userEvent.setup();
        const { onChange } = renderStep({ kind: 'navigate', screenId: 'scr_b', params: {} });
        await screen.findByLabelText('Screen');
        await user.click(screen.getByRole('button', { name: /add one/i }));
        await user.click(screen.getByRole('button', { name: /add one/i }));

        // Two unnamed rows are on screen…
        expect(screen.getByLabelText('Params 1 name')).toBeTruthy();
        expect(screen.getByLabelText('Params 2 name')).toBeTruthy();
        // …and neither has been written into the step, because neither has a
        // name yet. Nothing was destroyed to make room.
        const last = onChange.mock.calls.at(-1)?.[0];
        expect(last?.params ?? {}).toEqual({});
        expect(screen.getAllByText(/not saved until you do/i).length).toBe(2);
    });

    it('refuses a rename onto a name already in use, and says why', async () => {
        const { onChange } = renderStep({
            kind: 'navigate',
            screenId: 'scr_b',
            params: { recordId: { kind: 'static', value: '1' }, tab: { kind: 'static', value: 'notes' } },
        });
        await screen.findByLabelText('Screen');
        fireEvent.change(screen.getByLabelText('Params 2 name'), { target: { value: 'recordId' } });

        expect(screen.getByText(/already used above/i)).toBeTruthy();
        // The first row's value survived — the whole point.
        const last = onChange.mock.calls.at(-1)?.[0];
        expect(last === undefined || last.params.recordId).toBeTruthy();
        expect((screen.getByLabelText('Params 1 name') as HTMLInputElement).value).toBe('recordId');
    });

    it('commits the row once it is named', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ kind: 'navigate', screenId: 'scr_b', params: {} });
        await screen.findByLabelText('Screen');
        await user.click(screen.getByRole('button', { name: /add one/i }));
        fireEvent.change(screen.getByLabelText('Params 1 name'), { target: { value: 'recordId' } });
        expect(last().params).toEqual({ recordId: { kind: 'static', value: '' } });
    });
});

/**
 * `values` is REQUIRED on create_record. Emptying it to `undefined` is a hard
 * validation error, so removing the last column mapping made the whole
 * definition unsaveable — and the error surfaced far from the step that caused
 * it. An empty map is a shape the schema accepts.
 */
describe('StepSettings — emptying a required map keeps the app saveable', () => {
    it('empties create_record values to {} rather than dropping the field', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({
            kind: 'create_record',
            tableId: 'tbl_inv',
            values: { customer: { kind: 'static', value: 'x' } },
        });
        await screen.findByLabelText('Table');
        await user.click(screen.getByRole('button', { name: /remove values 1/i }));
        expect(last().values).toEqual({});
    });

    it('drops an optional map entirely when it is emptied', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({
            kind: 'navigate',
            screenId: 'scr_b',
            params: { recordId: { kind: 'static', value: '1' } },
        });
        await screen.findByLabelText('Screen');
        await user.click(screen.getByRole('button', { name: /remove params 1/i }));
        expect(last().params).toBeUndefined();
    });
});

/**
 * Only `recordValues` takes a full binding. `inputMapping` accepts
 * static|field (INPUT_MAPPING_KINDS) and `navParams` accepts static|formula —
 * anything else is a hard validation error. All three used the full
 * BindingField, which offers a table, a saved view, a connector, an automation's
 * result and an aggregate, so picking one made every later autosave 422 about a
 * mapping kind chosen from a list that offered it.
 */
describe('StepSettings — a keyed row offers only the kinds the server takes', () => {
    it('navigate params offer a fixed value or a formula, not a data source', async () => {
        renderStep({ kind: 'navigate', screenId: 'scr_b', params: { recordId: { kind: 'static', value: '1' } } });
        await screen.findByLabelText('Screen');
        expect(screen.getByLabelText('Where this value comes from')).toBeTruthy();
        expect(screen.getByLabelText('Fixed value')).toBeTruthy();
        // The binding chooser's cards are the tell that the wrong editor is up.
        expect(screen.queryByText('A table in this app')).toBeNull();
        expect(screen.queryByText('A saved view')).toBeNull();
    });

    it('switching a navigate param to a formula commits the formula shape', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ kind: 'navigate', screenId: 'scr_b', params: { recordId: { kind: 'static', value: '1' } } });
        await screen.findByLabelText('Screen');
        await user.click(screen.getByRole('radio', { name: /worked out/i }));
        expect(last().params.recordId).toEqual({ kind: 'formula', expr: '' });
    });

    it('a record’s values still get the full binding chooser', async () => {
        renderStep({ kind: 'create_record', tableId: 'tbl_inv', values: { customer: { kind: 'static', value: '' } } });
        await screen.findByLabelText('Table');
        // A blank static IS the chooser's "nothing picked yet" state.
        expect(await screen.findByText('A table in this app')).toBeTruthy();
    });
});

describe('StepSettings — run another action, and the model tier', () => {
    const withActions = {
        ...DEFINITION,
        actions: { act_main: { kind: 'sequence', steps: [] }, act_calc: { kind: 'sequence', steps: [], name: 'Work out the total' } },
    };
    function renderCall(step: ComponentProps<typeof StepSettings>['step'], actionId: string | null) {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const onChange = vi.fn();
        render(
            <QueryClientProvider client={client}>
                <EditorChromeContext.Provider value={{ appId: 'app-1' }}>
                    <StepSettings step={step} onChange={onChange} definition={withActions} screens={withActions.screens} actionId={actionId} />
                </EditorChromeContext.Provider>
            </QueryClientProvider>,
        );
        return { last: () => onChange.mock.calls.at(-1)?.[0] };
    }

    it('picks the action by name, never the action being edited', async () => {
        renderCall({ kind: 'call_action', actionId: '', params: {} }, 'act_main');
        const control = await screen.findByLabelText('Action');
        expect(control.tagName).toBe('SELECT');
        const texts = optionsOf(control);
        expect(texts).toContain('Work out the total');
        expect(texts).not.toContain('act_main');
    });

    it('adds a param row with a binding', async () => {
        const { last } = renderCall({ kind: 'call_action', actionId: 'act_calc', params: {} }, 'act_main');
        await userEvent.click(await screen.findByRole('button', { name: 'Add one' }));
        // One paste: the panel is controlled by the step, which this harness does not feed back.
        await userEvent.click(screen.getByLabelText('Params 1 name'));
        await userEvent.paste('quick');
        expect(last().params).toEqual({ quick: { kind: 'static', value: '' } });
    });

    it('switches the model tier between a tier name and a formula', async () => {
        const { last } = renderCall({ kind: 'ai_generate', prompt: 'p', modelTier: 'fast' }, null);
        expect((await screen.findByLabelText('Model tier') as HTMLInputElement).value).toBe('fast');
        await userEvent.click(screen.getByRole('radio', { name: 'Work it out with a formula' }));
        expect(last().modelTier).toEqual({ kind: 'formula', expr: '' });
    });

    it('error handling: retry tries, and onError picks the behaviour without touching its steps', async () => {
        const { last } = renderCall({ kind: 'ai_generate', prompt: 'p' }, null);
        await userEvent.selectOptions(await screen.findByLabelText('Times to try again'), '2');
        expect(last().retry).toEqual({ times: 2 });
        await userEvent.click(screen.getByRole('radio', { name: 'Fallback, then go on' }));
        expect(last().onError).toEqual({ steps: [] });
    });

    it('error handling: switching to "then stop" keeps the fallback steps; "stop and show why" removes the handler', async () => {
        const fallback = [{ kind: 'toast', message: 'x' }];
        const { last } = renderCall({ kind: 'ai_generate', prompt: 'p', retry: { times: 1, delayMs: 0 }, onError: { steps: fallback } }, null);
        await userEvent.click(await screen.findByRole('radio', { name: 'Fallback, then stop' }));
        expect(last().onError).toEqual({ steps: fallback, stop: true });
        await userEvent.click(screen.getByRole('radio', { name: 'Stop and show why' }));
        expect(last().onError).toBeUndefined();
        await userEvent.selectOptions(screen.getByLabelText('Times to try again'), '0');
        expect(last().retry).toBeUndefined();
    });
});

describe('StepSettings — update/delete_record: one row or rows matching a filter', () => {
    it('switching to a filter drops the recordId; switching back drops filter and limit', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ kind: 'delete_record', tableId: 'tbl_inv', recordId: { kind: 'formula', expr: 'item.id' } });
        await user.click(await screen.findByRole('radio', { name: 'Rows matching a filter' }));
        expect(last()).toEqual({ kind: 'delete_record', tableId: 'tbl_inv', filter: [] });
    });

    it('filter mode shows the limit field and never a text box for the filter', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ kind: 'delete_record', tableId: 'tbl_inv', filter: [{ field: 'customer', op: 'eq', value: 'ACME' }], limit: 20 });
        const limit = await screen.findByLabelText('At most');
        expect((limit as HTMLInputElement).value).toBe('20');
        await user.click(screen.getByRole('radio', { name: 'One row' }));
        expect(last()).toEqual({ kind: 'delete_record', tableId: 'tbl_inv' });
    });
});

describe('StepSettings: formula fields of the dynamic-text additions', () => {
    it('shows a toast message formula with its own label, beside the literal message', async () => {
        renderStep({ kind: 'toast', message: 'plain', tone: 'info' });
        expect(await screen.findByLabelText('Message (formula)')).toBeTruthy();
        expect(screen.getByLabelText('Message')).toBeTruthy();
    });

    it('writes the formula into the step and leaves the rest of it alone', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ kind: 'toast', message: 'plain', tone: 'info' });
        const box = await screen.findByLabelText('Message (formula)');
        await user.type(box, 'x');
        expect(last()).toMatchObject({ kind: 'toast', message: 'plain', tone: 'info', messageExpr: 'x' });
    });

    it('labels the open_url address formula and says which hosts it can open', async () => {
        renderStep({ kind: 'open_url', url: 'https://example.com', newTab: true });
        expect(await screen.findByLabelText('Address (formula)')).toBeTruthy();
        expect(screen.getByText(/Links from formulas/)).toBeTruthy();
    });
});

describe('StepSettings: a switch case picked by a formula', () => {
    const base = { kind: 'switch', expr: 'vars.n', cases: [{ value: 'a', steps: [] }, { value: 'b', steps: [] }], default: [] };

    it('offers a formula input per case', async () => {
        renderStep(base);
        expect(await screen.findByLabelText('Case 1 formula')).toBeTruthy();
        expect(screen.getByLabelText('Case 2 formula')).toBeTruthy();
    });

    it('setting a formula drops the value of that case only', async () => {
        const user = userEvent.setup();
        const { last } = renderStep(base);
        await user.type(await screen.findByLabelText('Case 2 formula'), 'q');
        expect(last().cases).toEqual([{ value: 'a', steps: [] }, { whenExpr: 'q', steps: [] }]);
    });

    it('clearing the formula removes the key, so the case is as it was', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ ...base, cases: [{ whenExpr: 'z', steps: [] }] });
        await user.clear(await screen.findByLabelText('Case 1 formula'));
        expect(last().cases).toEqual([{ steps: [] }]);
    });
});

describe('StepSettings: the guard of a server step and a formula input', () => {
    it('offers the guard on a server step under its own label, and writes the formula into the step', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ kind: 'run_automation', automationId: 'auto-1' });
        const box = await screen.findByLabelText('Only run when (checked on the server)');
        expect(screen.getByText(/the step is skipped and the rest goes on/)).toBeTruthy();
        await user.type(box, 'x');
        expect(last()).toMatchObject({ kind: 'run_automation', automationId: 'auto-1', guard: 'x' });
    });

    it('an emptied guard leaves the step: no empty formula is stored', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ kind: 'run_automation', automationId: 'auto-1', guard: 'x' });
        await user.clear(await screen.findByLabelText('Only run when (checked on the server)'));
        expect(last().guard).toBeUndefined();
        expect(JSON.parse(JSON.stringify(last()))).toEqual({ kind: 'run_automation', automationId: 'auto-1' });
    });

    it('a step that is not a server step has no guard', async () => {
        renderStep({ kind: 'toast', message: 'plain', tone: 'info' });
        await screen.findByLabelText('Message');
        expect(screen.queryByLabelText('Only run when (checked on the server)')).toBeNull();
    });

    it('an automation input can be worked out by a formula', async () => {
        const user = userEvent.setup();
        const { last } = renderStep({ kind: 'run_automation', automationId: 'auto-1', inputMapping: { customer: { kind: 'static', value: '1' } } });
        await screen.findByLabelText('Where this value comes from');
        await user.click(screen.getByRole('radio', { name: /worked out/i }));
        expect(last().inputMapping.customer).toEqual({ kind: 'formula', expr: '' });
    });
});
