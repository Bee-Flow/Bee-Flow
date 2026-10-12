/**
 * The Auto-map wand on a tool step, with the AI fallback behind it.
 *
 * One click: the deterministic pass fills what names and value kinds settle,
 * then the AI is asked for the required inputs still empty, and one toast
 * says what happened ("Auto-mapped 2 inputs (1 with AI)"). Both kinds of
 * fill wear the small "auto" pill. When the AI is not there the click is
 * exactly what it was before — no error, no second toast — and an answer
 * never lands in an input the author filled while it was on its way.
 *
 * The API is injected (`mappingApi`); nothing is module-mocked.
 *
 * Run: cd agent-hub && npx vitest run src/components/automation/Builder/flow/settings/actionEditors/integrationActionFields.aiAutoMap.test.tsx
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationActionFields as IntegrationActionFieldsJs } from './integrationActionFields';
import { VariablePickerProvider as VariablePickerProviderJs } from '../../../mapping/VariablePickerContext';
import { resetAiAutoMapAvailability } from '../../../mapping/aiAutoMap';
import type { SuggestMappingsRequest } from '../../../mapping/aiAutoMap';
import scopedStorage from '../../../../../../utils/scopedStorage';

const IntegrationActionFields = IntegrationActionFieldsJs as unknown as ComponentType<Record<string, unknown>>;
const VariablePickerProvider = VariablePickerProviderJs as unknown as ComponentType<Record<string, unknown> & { children: ReactNode }>;

const catalog = {
    apps: [{
        id: 'planner',
        label: 'Planner',
        actions: [{
            name: 'planner_create_task',
            label: 'Create task',
            inputSchema: {
                type: 'object',
                properties: {
                    subject: { type: 'string', title: 'Subject' },
                    ticketCode: { type: 'string', title: 'Ticket code', description: 'Our reference for the task' },
                },
                required: ['subject', 'ticketCode'],
            },
        }],
    }],
};

const MAIL = { id: 'AAMk1', subject: 'Invoice 2026-031', sender: { emailAddress: { address: 'jan@contoso.nl' } } };
const groups = [{
    id: 'g1', kind: 'integration_action', label: 'Get mail', basePath: 'steps.g1.output', sample: MAIL, hasRealData: true,
    fields: [
        { key: 'id', path: 'steps.g1.output.id', sample: 'AAMk1' },
        { key: 'subject', path: 'steps.g1.output.subject', sample: 'Invoice 2026-031' },
        { key: 'sender', path: 'steps.g1.output.sender', sample: MAIL.sender },
    ],
}];

const TEMPLATE = { kind: 'template', value: 'INV/{{steps.g1.output.id}}' };
const step = { id: 's2', type: 'integration_action', label: 'Create task', tool: 'planner_create_task', inputs: {} };

type Api = { suggestMappings: (body: SuggestMappingsRequest) => Promise<unknown> };

function Harness({ api, initial = {} }: { api: Api; initial?: Record<string, unknown> }) {
    const [draft, setDraft] = useState<Record<string, unknown>>({ tool: 'planner_create_task', inputs: initial });
    const set = (k: string, v: unknown) => setDraft(d => ({ ...d, [k]: typeof v === 'function' ? (v as (c: unknown, d: unknown) => unknown)(d[k], d) : v }));
    return (
        <VariablePickerProvider groups={groups} previewSample={null} stepLabelById={new Map([['g1', 'Get mail']])}>
            <IntegrationActionFields step={{ ...step, inputs: initial }} draft={draft} set={set} catalog={catalog} groups={groups} mappingApi={api} />
            <button type="button" onClick={() => set('inputs', (cur: Record<string, unknown>) => ({ ...cur, ticketCode: { kind: 'literal', value: 'MINE-1' } }))}>
                type my own code
            </button>
            <output data-testid="inputs">{JSON.stringify(draft.inputs)}</output>
        </VariablePickerProvider>
    );
}

const inputsNow = () => JSON.parse(screen.getByTestId('inputs').textContent || '{}');

let toasts: Array<{ kind: string; message: string }> = [];
const onToast = (e: Event) => { toasts.push((e as CustomEvent).detail.item); };

beforeEach(() => {
    cleanup();
    scopedStorage.setCurrentUser('test-user');
    try { localStorage.clear(); } catch { /* ignore */ }
    resetAiAutoMapAvailability();
    toasts = [];
    window.addEventListener('beeflow:toast', onToast);
});
afterEach(() => window.removeEventListener('beeflow:toast', onToast));

describe('the Auto-map wand with the AI fallback', () => {
    it('maps by name first, asks the AI only for what is still empty, and says so in one toast', async () => {
        const sent: SuggestMappingsRequest[] = [];
        const api = {
            suggestMappings: async (body: SuggestMappingsRequest) => {
                sent.push(body);
                return { suggestions: [{ key: 'ticketCode', binding: TEMPLATE, reason: 'INV/ and the mail id' }] };
            },
        };
        render(<Harness api={api} />);
        await userEvent.click(screen.getByRole('button', { name: /Auto-map/ }));

        await waitFor(() => expect(inputsNow().ticketCode).toEqual(TEMPLATE));
        expect(inputsNow().subject).toEqual({ kind: 'ref', path: 'steps.g1.output.subject' });
        // The AI was asked about the one input the names did not settle,
        // with the mail as its source and the subject as context.
        expect(sent).toHaveLength(1);
        expect(sent[0].params.map(p => p.key)).toEqual(['ticketCode']);
        expect(sent[0].sources).toEqual([{ root: 'steps.g1.output', label: 'Get mail', real: true, sample: MAIL }]);
        expect(sent[0].mapped).toEqual([{ key: 'subject', kind: 'ref', paths: ['steps.g1.output.subject'] }]);
        expect(sent[0].step).toEqual({ label: 'Create task', tool: 'planner_create_task' });
        await waitFor(() => expect(toasts.map(t => t.message)).toEqual(['Auto-mapped 2 inputs (1 with AI)']));
        // The name match reads "auto"; the input the AI filled reads "auto · AI".
        expect(screen.getAllByText('auto')).toHaveLength(1);
        expect(within(screen.getByTestId('param-ticketCode')).getByText('auto · AI')).toBeTruthy();
        // Drawn as text with a field pill named after the step, not as {{…}}.
        const field = screen.getByTestId('param-ticketCode');
        expect(field.querySelector('[data-ref-pill][data-raw="{{steps.g1.output.id}}"]')?.textContent).toBe('Get mail▸ Id');
        expect(field.textContent).not.toContain('{{');
    });

    it('without the AI the deterministic result stands, silently', async () => {
        let calls = 0;
        const api = { suggestMappings: async () => { calls += 1; throw Object.assign(new Error('not enabled'), { status: 403 }); } };
        render(<Harness api={api} />);
        await userEvent.click(screen.getByRole('button', { name: /Auto-map/ }));
        await waitFor(() => expect(toasts.map(t => t.message)).toEqual(['Auto-mapped 1 input']));
        expect(toasts[0].kind).toBe('success');
        expect(inputsNow()).toEqual({ subject: { kind: 'ref', path: 'steps.g1.output.subject' } });
        expect(screen.getAllByText('auto')).toHaveLength(1);
        // The next click does not knock on the same closed door.
        await userEvent.click(screen.getByRole('button', { name: /Auto-map/ }));
        await waitFor(() => expect(toasts).toHaveLength(2));
        expect(calls).toBe(1);
    });

    it('an answer never overwrites what the author filled while it was on its way', async () => {
        let answer: (v: unknown) => void = () => {};
        const api = { suggestMappings: () => new Promise((resolve) => { answer = resolve; }) };
        render(<Harness api={api} />);
        await userEvent.click(screen.getByRole('button', { name: /Auto-map/ }));
        await userEvent.click(screen.getByRole('button', { name: 'type my own code' }));
        answer({ suggestions: [{ key: 'ticketCode', binding: TEMPLATE }] });
        await waitFor(() => expect(toasts.map(t => t.message)).toEqual(['Auto-mapped 1 input']));
        expect(inputsNow().ticketCode).toEqual({ kind: 'literal', value: 'MINE-1' });
    });

    it('a second click while the AI is still answering asks nothing more and says nothing extra', async () => {
        let calls = 0;
        let answer: (v: unknown) => void = () => {};
        const api = { suggestMappings: () => { calls += 1; return new Promise((resolve) => { answer = resolve; }); } };
        render(<Harness api={api} />);
        await userEvent.click(screen.getByRole('button', { name: /Auto-map/ }));
        await userEvent.click(screen.getByRole('button', { name: /Auto-map/ }));
        answer({ suggestions: [{ key: 'ticketCode', binding: TEMPLATE }] });
        await waitFor(() => expect(toasts.map(t => t.message)).toEqual(['Auto-mapped 2 inputs (1 with AI)']));
        expect(calls).toBe(1);
    });

    it('does not ask the AI when the required inputs are already filled', async () => {
        let calls = 0;
        const api = { suggestMappings: async () => { calls += 1; return {}; } };
        render(<Harness api={api} initial={{ ticketCode: { kind: 'literal', value: 'X-1' } }} />);
        await userEvent.click(screen.getByRole('button', { name: /Auto-map/ }));
        await waitFor(() => expect(toasts.map(t => t.message)).toEqual(['Auto-mapped 1 input']));
        expect(calls).toBe(0);
    });
});
