import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDemoTransport } from '@/utils/helpers';
import { stub } from '@/test/mocks';
import { EditorChromeContext } from '@/components/admin/Studio/AppStudio/editor/EditorChromeContext';
import StepSettings from '../index';
import { StepField } from '../StepField';
import type { AppAction, AppDefinition } from '@/components/admin/Studio/AppStudio/inspector/appDefinition';
import type { StepFieldProps } from '../../StepSettings.types';

/**
 * The step controls for AI steps and approvals, driven with REAL step shapes: the steps of the
 * compat corpus templates (server/appStudio/compat/corpus), the real step catalog, and the real
 * canonicalizer. The rule each edit is held to: what the editor writes is exactly what
 * canonicalize keeps, so the saved step is the step the editor shows.
 */

const require = createRequire(import.meta.url);
const SERVER = path.resolve(__dirname, '../../../../../../../../../server');
const { canonicalizeAppDefinition } = require(path.join(SERVER, 'appStudio/canonicalize.js'));
const { validateAppDefinition } = require(path.join(SERVER, 'appStudio/validate.js'));
const { STEP_SPECS } = require(path.join(SERVER, 'appStudio/componentSpecs.js'));
const CORPUS = path.join(SERVER, 'appStudio/compat/corpus');

const DIRECTORY = { members: [{ id: 'u_anna', name: 'Anna' }, { id: 'u_bram', name: 'Bram' }], groups: [{ id: 'g_fin', name: 'Finance team' }] };

type Step = AppAction & Record<string, unknown>;
type Corpus = { definition: AppDefinition; dataModel?: { tables?: unknown[] } };

const corpus = (name: string): Corpus => JSON.parse(fs.readFileSync(path.join(CORPUS, `${name}.json`), 'utf8'));

/** Every step of `kinds` in an app, with where it sits. */
function stepsOf(app: Corpus, kinds: string[]): Step[] {
    const out: Step[] = [];
    const walk = (x: unknown) => {
        if (Array.isArray(x)) { x.forEach(walk); return; }
        if (!x || typeof x !== 'object') return;
        const o = x as Record<string, unknown>;
        if (typeof o.kind === 'string' && kinds.includes(o.kind) && o !== app.definition) out.push(o as Step);
        Object.values(o).forEach(walk);
    };
    walk(Object.values(app.definition.actions || {}).flatMap((a) => (a as { steps?: unknown[] }).steps || []));
    return out;
}

/** One step as canonicalize stores it, inside a one-action app. */
function canon(step: Step): Step {
    const def = { schemaVersion: 2, meta: { name: 'T' }, theme: {}, homeScreenId: 'scr', screens: [{ id: 'scr', name: 'T', sections: [] }], actions: { act_probe: { kind: 'sequence', steps: [step] } } };
    return canonicalizeAppDefinition(def).def.actions.act_probe.steps[0];
}

const INVOICES = corpus('template-invoice-approvals');
const QUOTES = corpus('template-quote-intake');
const TABLES = [...(INVOICES.dataModel?.tables || []), ...(QUOTES.dataModel?.tables || [])];
/** What the editor's requests get: the real catalog, the corpus tables, one knowledge base, a small directory. */
function answer(url: string): unknown {
    if (url.includes('/studio-apps/catalog')) return { components: {}, actions: { stepSpecs: STEP_SPECS } };
    if (url.includes('/data/tables')) return { tables: TABLES };
    if (url.includes('/api/kb')) return [{ id: 'kb_policy', name: 'Payment policy' }];
    if (url.includes('/approvals/directory')) return DIRECTORY;
    return {};
}

// The fetch seam authFetch already has, instead of a module mock: every request is answered here.
beforeEach(() => { setDemoTransport(async (url: string) => new Response(JSON.stringify(answer(String(url))), { status: 200, headers: { 'Content-Type': 'application/json' } })); });
afterEach(() => { setDemoTransport(null); });

function wrap(ui: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}><EditorChromeContext.Provider value={{ appId: 'app-1' }}>{ui}</EditorChromeContext.Provider></QueryClientProvider>);
}

/** One field of a step, through StepField and the registered control, with the step fed back in. */
function renderField(initial: Step, fieldKey: string) {
    const writes: Step[] = [];
    function Harness() {
        const [step, setStep] = useState(initial);
        const take = (next: Step) => { writes.push(next); setStep(next); };
        return (
            <StepField
                fieldKey={fieldKey}
                fs={STEP_SPECS[step.kind].fields[fieldKey]}
                value={step[fieldKey]}
                step={step}
                onChange={(v) => take({ ...step, [fieldKey]: v })}
                onStepChange={(next) => take(next as Step)}
                definition={INVOICES.definition}
                node={null}
                options={{}}
                references={stub<StepFieldProps['references']>({ fieldsFor: () => [], options: {} })}
                formFields={[]}
                disabled={false}
            />
        );
    }
    wrap(<Harness />);
    const last = () => writes.at(-1) as Step;
    /** The last write, checked: canonicalize keeps it as it is. */
    const kept = () => { const s = last(); expect(canon(s)).toEqual(JSON.parse(JSON.stringify(s))); return s; };
    return { writes, last, kept };
}

const extractLines = () => canon(stepsOf(INVOICES, ['ai_extract']).find((s) => (s.writeTo as { tableId?: string })?.tableId === 'tbl_ialine') as Step);
/** The fallback route of the invoice app: four stages, two of them conditional. */
const approval = () => canon(stepsOf(INVOICES, ['request_approval']).find((s) => (s.stages as unknown[]).length === 4) as Step);

describe('the corpus steps load into the step editor without a plain text box over structured data', () => {
    const steps = [...stepsOf(INVOICES, ['ai_extract', 'request_approval']), ...stepsOf(QUOTES, ['ai_extract', 'ai_generate', 'file_intake'])];

    it.each(steps.map((s, i) => [`${i} ${s.kind}`, s]))('%s', async (_name, step) => {
        const onChange = vi.fn();
        const { container } = wrap(<StepSettings step={step as Step} onChange={onChange} definition={INVOICES.definition} />);
        await screen.findByText((_, el) => el?.getAttribute('data-step-settings') === (step as Step).kind);
        await waitFor(() => expect(container.querySelector('[data-step-control]')).not.toBeNull());
        const boxes = [...container.querySelectorAll('input, textarea')] as HTMLInputElement[];
        expect(boxes.filter((b) => b.value.includes('[object Object]'))).toEqual([]);
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe('AI step: schema, writeTo with replaceWhere, prompt, knowledge bases, context sources', () => {
    it('a schema rename carries its writeTo column, and both are what canonicalize keeps', async () => {
        const user = userEvent.setup();
        const h = renderField(extractLines(), 'schema');
        const name = await screen.findByLabelText('Field 1 name');
        await user.type(name, 'position', { initialSelectionStart: 0, initialSelectionEnd: 'line_no'.length });
        const s = h.kept();
        expect((s.schema as Array<{ name: string }>)[0].name).toBe('position');
        expect((s.writeTo as { mapping: Record<string, string> }).mapping.line_no).toBe('position');
        await user.click(screen.getByRole('button', { name: '+ Add field' }));
        expect((h.kept().schema as unknown[]).at(-1)).toEqual({ name: 'field', type: 'string' });
    });

    it('replaceWhere: a clause and an OR group are written as the server keeps them; switching it off removes it', async () => {
        const user = userEvent.setup();
        const h = renderField(extractLines(), 'writeTo');
        await user.click(await screen.findByRole('checkbox', { name: 'Delete matching rows before writing' }));
        await user.click(screen.getByRole('button', { name: /Add filter/ }));
        const replace = screen.getByText((_, el) => el?.getAttribute('data-replace-where') === 'on') as HTMLElement;
        await user.selectOptions(within(replace).getAllByLabelText('Filter field')[0], 'invoice_no');
        await user.click(within(replace).getByRole('button', { name: 'Add an either/or group' }));
        const s = h.kept();
        const rw = (s.writeTo as { replaceWhere: unknown[] }).replaceWhere;
        expect(rw[0]).toMatchObject({ field: 'invoice_no', op: 'eq' });
        expect(rw[1]).toHaveProperty('any');
        expect((s.writeTo as Record<string, unknown>).constants).toEqual((extractLines().writeTo as Record<string, unknown>).constants);
        await user.click(screen.getByRole('checkbox', { name: 'Delete matching rows before writing' }));
        expect((h.kept().writeTo as Record<string, unknown>).replaceWhere).toBeUndefined();
    });

    it('switching writeTo on over an untouched schema takes the table columns as the schema, as canonicalize stores it', async () => {
        const user = userEvent.setup();
        const { writeTo: _w, ...rest } = extractLines();
        const h = renderField(canon({ ...rest, schema: [{ name: 'field', type: 'string' }] } as Step), 'writeTo');
        await user.click(await screen.findByRole('checkbox', { name: 'Write extracted rows to a data table' }));
        const s = h.kept();
        expect((s.schema as unknown[]).length).toBeGreaterThan(1);
        expect((s.writeTo as { tableId: string }).tableId).toBe((TABLES[0] as { id: string }).id);
    });

    it('file_intake maps its fixed outputs and never gets a schema', async () => {
        const h = renderField(canon(stepsOf(QUOTES, ['file_intake'])[0]), 'writeTo');
        expect(await screen.findByLabelText('Column for base_name')).toBeTruthy();
        expect(screen.queryByRole('button', { name: "Use this table's columns" })).toBeNull();
        await userEvent.setup().selectOptions(screen.getByLabelText('Column for role'), '');
        expect(h.kept().schema).toBeUndefined();
    });

    it('the prompt is a multi-line box with its count, and typing keeps the step canonical', async () => {
        const user = userEvent.setup();
        const step = canon(stepsOf(QUOTES, ['ai_generate'])[0]);
        const h = renderField(step, 'prompt');
        const box = await screen.findByLabelText('Prompt');
        expect(box.tagName).toBe('TEXTAREA');
        expect(screen.getByText(/of 32,000 characters/)).toBeTruthy();
        await user.type(box, ' Thanks.');
        expect(h.kept().prompt).toBe(`${step.prompt} Thanks.`);
    });

    it('knowledge bases are picked by name', async () => {
        const user = userEvent.setup();
        const h = renderField(extractLines(), 'knowledgeBaseIds');
        await user.click(await screen.findByLabelText('Ground in Payment policy'));
        expect(h.kept().knowledgeBaseIds).toEqual(['kb_policy']);
    });

    it('context sources: a label edit and a removal stay canonical', async () => {
        const user = userEvent.setup();
        const base = canon({ ...canon(stepsOf(QUOTES, ['ai_generate'])[0]), contextSources: [{ label: 'Order lines', source: { kind: 'formula', expr: 'vars.po' } }] });
        const h = renderField(base, 'contextSources');
        const label = await screen.findByLabelText('Name of source 1');
        await user.type(label, ' (PO)');
        expect(h.kept().contextSources).toEqual([{ label: 'Order lines (PO)', source: { kind: 'formula', expr: 'vars.po' } }]);
        await user.click(screen.getByRole('button', { name: 'Remove source 1' }));
        expect(h.kept().contextSources).toBeUndefined();
    });
});

describe('request_approval: questions, stages and the onDecided hook', () => {
    it('questions: a reworded label keeps its binding name; a new one is minted from its label on blur', async () => {
        const user = userEvent.setup();
        const h = renderField(approval(), 'fields');
        const first = await screen.findByLabelText('Question 1');
        await user.type(first, ' in full');
        await user.tab();
        expect((h.kept().fields as Array<{ name: string }>)[0].name).toBe('goods_received');
        await user.click(screen.getByRole('button', { name: 'Add a question' }));
        await user.type(screen.getByLabelText('Question 3'), 'Cost centre');
        await user.tab();
        await user.selectOptions(screen.getByLabelText('Answer type of question 3'), 'select');
        const q3 = (h.kept().fields as Array<Record<string, unknown>>)[2];
        expect(q3).toEqual({ name: 'cost_centre', type: 'select', label: 'Cost centre' });
        expect(screen.getByText('{{answers.cost_centre}}')).toBeTruthy();
    });

    it('stages: rename, add an approver, quorum, move, condition and remove keep every key and stay canonical', async () => {
        const user = userEvent.setup();
        const h = renderField(approval(), 'stages');
        const name = await screen.findByLabelText('Name of stage 1');
        await user.type(name, ' review');
        await user.selectOptions(await screen.findByLabelText('Add an approver to stage 1'), 'u:u_anna');
        await user.selectOptions(screen.getByLabelText('Decision rule for stage 1'), 'quorum');
        await user.click(screen.getByRole('button', { name: 'Move stage 2 earlier' }));
        let stages = h.kept().stages as Array<Record<string, unknown>>;
        expect(stages.map((s) => s.key)).toEqual(['budget', 'lead', 'finance', 'director']);
        expect(stages[1]).toMatchObject({ name: 'Team lead review', rule: 'quorum', quorum: 2, approvers: [{ groupId: 'replace-me-team-leads' }, { userId: 'u_anna' }] });
        await user.click(screen.getAllByRole('button', { name: '+ Only ask this stage when…' })[0]);
        await user.click(screen.getByRole('button', { name: 'Remove stage 4' }));
        stages = h.kept().stages as Array<Record<string, unknown>>;
        expect(stages.map((s) => s.key)).toEqual(['budget', 'lead', 'finance']);
    });

    it('the first stage clears the single approver it supersedes, so the step validates', async () => {
        const user = userEvent.setup();
        const { stages: _drop, ...rest } = approval();
        const h = renderField(canon({ ...rest, assigneeUserId: 'u_bram', escalateToUserId: 'u_anna', escalateAfterHours: 24 } as Step), 'stages');
        await user.selectOptions(await screen.findByLabelText('Add a stage'), 'g:g_fin');
        const s = h.kept();
        expect(s.stages).toEqual([{ key: 's1', approvers: [{ groupId: 'g_fin' }], rule: 'all' }]);
        expect(s.assigneeUserId).toBeNull();
        expect(s.escalateToUserId).toBeNull();
        const def = { ...INVOICES.definition, actions: { ...INVOICES.definition.actions, act_probe: { kind: 'sequence', steps: [s] } } };
        const errors = validateAppDefinition(canonicalizeAppDefinition(def).def, { dataModel: INVOICES.dataModel }).errors as Array<{ code: string; path: string }>;
        expect(errors.filter((e) => e.path.includes('act_probe') && e.code === 'action.approval_stages_conflict')).toEqual([]);
    });

    it('onDecided: edit a template, set a column on another outcome, stop setting one', async () => {
        const user = userEvent.setup();
        const h = renderField(approval(), 'onDecided');
        const status = await screen.findByLabelText('Status When approved');
        await user.clear(status);
        await user.type(status, 'paid');
        const expired = screen.getByText((_, el) => el?.getAttribute('data-outcome') === 'expired') as HTMLElement;
        await user.selectOptions(within(expired).getByLabelText('Set a column When nobody decided in time'), 'decided_by_name');
        await user.click(screen.getAllByRole('button', { name: 'Stop setting Reason rejected' })[0]);
        const hook = h.kept().onDecided as { set: Record<string, Record<string, unknown>> };
        expect(hook.set.approved.status).toBe('paid');
        expect(hook.set.approved).not.toHaveProperty('rejection_reason');
        expect(hook.set.expired.decided_by_name).toBe('');
        expect(hook.set.rejected.rejection_reason).toBe('{{reason}}');
    });
});

describe('write filters offer OR groups', () => {
    it('update_record in filter mode has "Add an either/or group"', async () => {
        wrap(<StepSettings step={{ kind: 'update_record', tableId: 'tbl_iainv', filter: [{ field: 'status', op: 'eq', value: 'open' }], values: {} } as Step} onChange={vi.fn()} definition={INVOICES.definition} />);
        expect(await screen.findByRole('button', { name: 'Add an either/or group' })).toBeTruthy();
    });
});
