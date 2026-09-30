/**
 * Every declarative spec, round-tripped: a step becomes the draft its form
 * edits, the author changes fields the way the editor does (writeField), and
 * the patch that would be saved is exactly the one the web's editor saves for
 * the same edit (formState's buildPatch — only what changed).
 */

import type { FlowCatalog } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';
import type { FlowDefinition } from '@/features/flow-editor/model';

import { isVisible, readField, specDraft, specKeys, specPatch } from './runtime';
import { SPECS, categoriesPatch, findActionAndSiblings, specFor, switchOperation } from './specs';
import { findField, editThrough, specContext } from './testing';

const step = (type: string, rest: Record<string, unknown> = {}): FlowNode => ({ id: 's1', type, label: 'Step', icon: null, ...rest });
const spec = (type: string) => {
    const found = specFor(type);
    if (!found) throw new Error(`no spec for ${type}`);
    return found;
};

/**
 * The step as it is after its first save. A sparse fixture has keys the form
 * writes defaults for on the first edit (`title: ''`, `format: 'pdf'`, as the
 * web writes them); starting from the saved shape, a patch holds only what
 * the scripted edit changed.
 */
const saved = (type: string, rest: Record<string, unknown> = {}): FlowNode => {
    const raw = step(type, rest);
    const s = spec(type);
    return { ...raw, ...specPatch(s, raw, specDraft(s, raw)) };
};

describe('the spec registry', () => {
    it('has a spec for every type this lane edits declaratively', () => {
        expect(Object.keys(SPECS).sort()).toEqual(
            [
                'aggregate', 'call_block', 'call_layer', 'data_extraction', 'datetime', 'dedupe', 'fill_document', 'generate_document',
                'guard', 'integration_action', 'knowledge_write', 'layer_output', 'limit', 'note', 'notification', 'presentation',
                'return_to_app', 'slide', 'stop_error', 'summarize', 'tokenize', 'untokenize', 'wait',
            ].sort(),
        );
        expect(specFor('ai_step')).toBeNull();
        expect(specFor('constructor')).toBeNull();
    });

    it.each(Object.keys(SPECS))('%s: every plain field edits a key its draft carries (else the save drops it)', (type) => {
        const s = spec(type);
        const draft = specDraft(s, step(type));
        const missing = specKeys(s).filter((k) => !(k in draft));
        expect({ type, missing }).toEqual({ type, missing: [] });
    });
});

describe('round trips', () => {
    it('wait: a duration in seconds', () => {
        expect(editThrough(spec('wait'), step('wait', { seconds: 5 }), [['seconds', 7200]]).patch).toEqual({ seconds: 7200 });
    });

    it('notification: body, and the channels in the bell-first shape', () => {
        const s = spec('notification');
        const original = step('notification', { title: 'Hi', body: '', channels: ['notification'] });
        const ctx = specContext(original);
        expect(readField(findField(s, 'channels'), specDraft(s, original), ctx)).toEqual(['inapp']);
        const { patch } = editThrough(s, original, [
            ['body', 'From {{trigger.output.from}}'],
            ['channels', ['inapp', 'email']],
        ]);
        expect(patch).toEqual({ body: 'From {{trigger.output.from}}', channels: ['inapp', 'email'] });
    });

    it('notification: untouched channels are not written', () => {
        expect(editThrough(spec('notification'), saved('notification', { body: 'x' }), [['body', 'y']]).patch).toEqual({ body: 'y' });
    });

    it('limit: source, which end, how many, and a cleared cap', () => {
        const { patch } = editThrough(spec('limit'), step('limit', { arrayRef: '', count: 10, mode: 'first', maxItems: 50 }), [
            ['arrayRef', 'steps.a.output.items'],
            ['mode', 'last'],
            ['count', 3],
            ['maxItems', ''],
        ]);
        expect(patch).toEqual({ arrayRef: 'steps.a.output.items', mode: 'last', count: 3, maxItems: undefined });
    });

    it('dedupe: the key field is trimmed, and blank is absent', () => {
        expect(editThrough(spec('dedupe'), step('dedupe', { arrayRef: 'x' }), [['keyField', ' id ']]).patch).toEqual({ keyField: 'id' });
        expect(editThrough(spec('dedupe'), step('dedupe', { arrayRef: 'x', keyField: 'id' }), [['keyField', '  ']]).patch).toEqual({
            keyField: undefined,
        });
    });

    it('aggregate and summarize: field and operation; counting asks for no field', () => {
        expect(editThrough(spec('aggregate'), step('aggregate', { arrayRef: 'x' }), [['field', 'email']]).patch).toEqual({ field: 'email' });
        const s = spec('summarize');
        const { draft, patch } = editThrough(s, saved('summarize', { arrayRef: 'x', op: 'sum' }), [['op', 'count']]);
        expect(patch).toEqual({ op: 'count' });
        expect(isVisible(findField(s, 'field'), draft, specContext(step('summarize')))).toBe(false);
    });

    it('datetime: "Works on" is the presence of arrayRef, and a dropped column switches to it', () => {
        const s = spec('datetime');
        expect(editThrough(s, saved('datetime', { op: 'format' }), [['worksOn', 'items']]).patch).toEqual({ arrayRef: '' });
        const listed = saved('datetime', { op: 'format', arrayRef: 'steps.a.output.rows', target: 'when' });
        expect(editThrough(s, listed, [['worksOn', 'single']]).patch).toEqual({ arrayRef: undefined, target: undefined });
        const dropped = editThrough(s, step('datetime', { op: 'format' }), [['input', 'steps.a.output.rows[*].date']]);
        expect(dropped.patch).toMatchObject({ arrayRef: 'steps.a.output.rows', input: expect.stringContaining('date') });
    });

    it('stop_error and return_to_app: the message, and "nothing" as null', () => {
        expect(editThrough(spec('stop_error'), step('stop_error'), [['message', 'Over budget']]).patch).toEqual({ message: 'Over budget' });
        const r = editThrough(spec('return_to_app'), step('return_to_app'), [
            ['toastMessage', 'Saved'],
            ['toastTone', 'success'],
            ['navigateScreenId', 'scr_orders'],
            ['refresh', 'tableViews'],
        ]);
        expect(r.patch).toEqual({
            toast: { message: 'Saved', tone: 'success' },
            navigateTo: { screenId: 'scr_orders' },
            refresh: 'tableViews',
            onError: 'stay',
        });
    });

    it('layer_output: the author’s own fields keep an empty value', () => {
        const { patch } = editThrough(spec('layer_output'), step('layer_output'), [['fields', { total: { kind: 'literal', value: '' } }]]);
        expect(patch).toEqual({ fields: { total: { kind: 'literal', value: '' } } });
    });

    it('knowledge_write: the base, the text, and a non-default strategy', () => {
        const { patch } = editThrough(spec('knowledge_write'), saved('knowledge_write'), [
            ['knowledgeBaseId', 'kb1'],
            ['content', '{{steps.ai.output.text}}'],
            ['nearDuplicateStrategy', 'merge'],
        ]);
        expect(patch).toEqual({ knowledgeBaseId: 'kb1', content: '{{steps.ai.output.text}}', nearDuplicateStrategy: 'merge' });
        expect(
            editThrough(spec('knowledge_write'), saved('knowledge_write', { nearDuplicateStrategy: 'merge' }), [['nearDuplicateStrategy', 'skip']]).patch,
        ).toEqual({ nearDuplicateStrategy: undefined });
    });

    it('data_extraction: the source, the rows (blank ones dropped) and the instructions', () => {
        const { patch } = editThrough(spec('data_extraction'), step('data_extraction'), [
            ['source', { kind: 'ref', path: 'steps.mail.output.body' }],
            ['fields', [{ name: 'invoice_date', type: 'date', description: '', required: true }, { name: '', type: 'string', description: '', required: false }]],
            ['instructions', 'Dates are day first.'],
        ]);
        expect(patch).toEqual({
            source: { kind: 'ref', path: 'steps.mail.output.body' },
            fields: [{ name: 'invoice_date', type: 'date', required: true }],
            instructions: 'Dates are day first.',
        });
    });

    it('generate_document: the file, with the expiry clamped to what the validator allows', () => {
        const { patch } = editThrough(spec('generate_document'), saved('generate_document', { content: 'x' }), [
            ['format', 'docx'],
            ['fileName', 'offer-{{trigger.output.n}}'],
            ['expiresInDays', 200],
        ]);
        expect(patch).toEqual({ format: 'docx', fileName: 'offer-{{trigger.output.n}}', expiresInDays: 90 });
    });

    it('fill_document: a placeholder value and a kept copy', () => {
        const original = saved('fill_document', { documentId: 'd1', documentName: 'Invoice', values: { naam: '{{trigger.output.name}}' } });
        const { patch } = editThrough(spec('fill_document'), original, [
            ['values', { naam: '{{steps.x.output.name}}' }],
            ['saveCopy', true],
            ['copyName', 'Invoice {{trigger.output.n}}'],
        ]);
        expect(patch).toEqual({ values: { naam: '{{steps.x.output.name}}' }, saveCopy: true, copyName: 'Invoice {{trigger.output.n}}' });
    });

    it('slide: picking a chart keeps exactly one visual', () => {
        const { patch } = editThrough(spec('slide'), step('slide', { title: 'Q3', image: 'data:x' }), [
            ['visual', 'chart'],
            ['chartType', 'line'],
            ['chartData', '[{"m":"jan","v":1}]'],
        ]);
        expect(patch).toMatchObject({ chart: { type: 'line', data: [{ m: 'jan', v: 1 }] }, image: undefined });
    });

    it('presentation: a list of slide references becomes the `slides` array', () => {
        const { patch } = editThrough(spec('presentation'), saved('presentation', { slides: '{{steps.ai.output.text}}' }), [
            ['slidesMode', 'list'],
            ['slideRows', ['{{steps.s1.output.slide}}', '  ', '{{steps.s2.output.slide}}']],
        ]);
        expect(patch).toEqual({ slides: ['{{steps.s1.output.slide}}', '{{steps.s2.output.slide}}'] });
    });

    it('privacy: the mode decides the runtime type, and narrowing categories back to all is null', () => {
        const s = spec('guard');
        const { patch } = editThrough(s, step('guard', { sourceRef: 'steps.a.output.body' }), [['mode', 'hide']]);
        expect(patch).toMatchObject({ type: 'tokenize' });
        const narrowed = editThrough(s, saved('guard'), [['categories', ['Email', 'PhoneNumber']]]);
        expect(narrowed.patch).toEqual({ categories: ['Email', 'PhoneNumber'] });
        expect(categoriesPatch([])).toBeNull();
    });

    it('privacy: a mode switch that costs a connection is asked about first', () => {
        const s = spec('guard');
        const guard = step('guard', { onFound: {} });
        const ctx = specContext(guard, {
            definition: { steps: [guard], edges: [{ from: 's1', to: 'a', label: 'then' }, { from: 's1', to: 'b', label: 'else' }] } as unknown as FlowDefinition,
        });
        const mode = findField(s, 'mode');
        expect(mode.confirm?.('hide', specDraft(s, guard), ctx)?.message[1]).toMatch(/clean/);
        expect(mode.confirm?.('check_hide', specDraft(s, guard), ctx)).toBeNull();
    });

    it('call_block / call_layer: one binding per declared input', () => {
        const { patch } = editThrough(spec('call_block'), step('call_block', { blockId: 'b1' }), [
            ['inputs', { iban: { kind: 'ref', path: 'trigger.output.iban' }, empty: { kind: 'literal', value: '' } }],
        ]);
        expect(patch).toEqual({ inputs: { iban: { kind: 'ref', path: 'trigger.output.iban' } } });
    });

    it('note: its text, and amber stored as absence', () => {
        const { patch } = editThrough(spec('note'), step('note', { text: 'old', color: 'blue' }), [
            ['text', 'Remember the VAT'],
            ['color', 'amber'],
        ]);
        expect(patch).toEqual({ text: 'Remember the VAT', color: undefined });
        expect(editThrough(spec('note'), saved('note'), [['color', 'rose']]).patch).toEqual({ color: 'rose' });
    });
});

describe('integration_action', () => {
    const catalog = {
        apps: [
            {
                id: 'gmail',
                label: 'Gmail',
                actions: [
                    { name: 'gmail_search', label: 'Search', inputSchema: { properties: { query: {}, maxResults: {} } }, sideEffect: false },
                    { name: 'gmail_send', label: 'Send', inputSchema: { properties: { to: {}, query: {} } }, sideEffect: true },
                ],
            },
        ],
    } as unknown as FlowCatalog;

    it('finds the action and its siblings, by tool or by app', () => {
        expect(findActionAndSiblings(catalog, 'gmail_send', null)).toMatchObject({ action: { name: 'gmail_send' }, appLabel: 'Gmail' });
        expect(findActionAndSiblings(catalog, 'gone', 'gmail').siblings).toHaveLength(2);
        expect(findActionAndSiblings(null, 'x', null)).toEqual({ action: null, siblings: [], appLabel: null });
    });

    it('switching the operation keeps the shared inputs and follows the label and side effect', () => {
        const original = step('integration_action', { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'x' }, maxResults: { kind: 'literal', value: 5 } } });
        const ctx = specContext(original, { catalog });
        const draft = specDraft(spec('integration_action'), original);
        expect(switchOperation(draft, ctx, 'gmail_send')).toEqual({
            tool: 'gmail_send',
            label: 'Send',
            inputs: { query: { kind: 'literal', value: 'x' } },
            sideEffect: true,
        });
        const { patch } = editThrough(spec('integration_action'), original, [['operation', 'gmail_send']], { catalog });
        expect(patch).toMatchObject({ tool: 'gmail_send', label: 'Send', inputs: { query: { kind: 'literal', value: 'x' } }, sideEffect: true });
    });
});
