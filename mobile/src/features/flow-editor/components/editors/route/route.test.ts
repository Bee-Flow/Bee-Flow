/**
 * The Condition editor's edits as the node editor saves them: the step's
 * unified route (extractFormState), an edit (routeEdits), and the patch —
 * which picks the runtime type (condition / switch / filter) through
 * writeRoute — plus the condition builder's state and the helpers around it.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, extractFormState } from '@/features/flow-editor/formState';
import type { Route } from '@/features/flow-editor/model';

import { configuredRules, losingWires, sampleRowsFor } from './assistModel';
import { canUseVisual, conditionState, fieldAsExpression, fieldFromExpression, isTrivialValue, readsListAsValue, withoutRow } from './conditionState';
import { itemFieldOptions, itemScope, upstreamFieldOptions } from './fieldOptions';
import { otherwiseSentence, outputCount } from './OutputsChooser';
import {
    addRule,
    applySuggestion,
    checkCaseName,
    chooseSeveral,
    collapseToOne,
    convertToConditions,
    keepRestPatch,
    losingOutputs,
    removeRule,
    updateRule,
    wiredCaseNames,
    type RoutePatch,
} from './routeEdits';

/** The O3 names as the editor makes them: "Output 1", "Output 2", … */
const outputName = (n: number) => `Output ${n}`;
const T = (_key: string, en: string, vars: Record<string, unknown> = {}) => en.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

function edit(step: Record<string, unknown>, change: (route: Route) => RoutePatch | null) {
    const draft = extractFormState(step as FlowNode);
    const route = draft.route as Route;
    const next = { ...draft, route: { ...route, ...(change(route) ?? {}) } };
    return buildPatch(step as FlowNode, next);
}

const condition = { id: 'c1', type: 'condition', label: 'Check', expr: 'trigger.output.amount > 10' };
const router = {
    id: 's1',
    type: 'switch',
    label: 'Route',
    expr: '',
    cases: [
        { name: 'urgent', expr: 'contains(trigger.output.subject, "urgent")' },
        { name: 'invoice', expr: 'contains(trigger.output.subject, "invoice")' },
    ],
    defaultBranch: 'invoice',
};

describe('the number of outputs', () => {
    it('grows a condition to a two-output router that fans out, its outputs named "Output 1", "Output 2" (O3)', () => {
        const patch = edit(condition, (r) => chooseSeveral(r, outputName));
        expect(patch.type).toBe('switch');
        expect(patch.cases).toEqual([
            { name: 'Output 1', expr: 'trigger.output.amount > 10' },
            { name: 'Output 2', expr: '' },
        ]);
        expect(patch.matchMode).toBe('all');
    });

    it('keeps a name the author chose when growing, and does nothing when there already are several', () => {
        expect(chooseSeveral({ rules: [{ name: 'urgent', expr: 'x', value: '' }] }, outputName)?.rules?.map((r) => r.name)).toEqual(['urgent', 'Output 2']);
        expect(chooseSeveral({ rules: router.cases.map((c) => ({ ...c, value: '' })) }, outputName)).toBeNull();
    });

    it('collapses a router back to a condition, first-match, with no default', () => {
        const patch = edit(router, collapseToOne);
        expect(patch.type).toBe('condition');
        expect(patch.expr).toBe('contains(trigger.output.subject, "urgent")');
        expect(patch.cases).toBeUndefined();
    });

    it('names the wired outputs collapsing would cost', () => {
        const route = extractFormState(router as unknown as FlowNode).route as Route;
        expect(losingOutputs(route, new Set(['invoice', 'nope']))).toEqual(['invoice']);
    });
});

describe('sending what does not match to Otherwise (BFSF-485 F2)', () => {
    const filter = { id: 'f1', type: 'filter', arrayRef: 'steps.s.output.rows', expr: 'item.total > 5' };

    it('saves one output with the box ticked as a list switch with one case, and unticked as a filter again', () => {
        const on = edit(filter, (r) => keepRestPatch(r, true, outputName));
        expect({ ...filter, ...on }).toMatchObject({ type: 'switch', arrayRef: 'steps.s.output.rows', routeStyle: 'rules', cases: [{ name: 'Output 1', expr: 'item.total > 5' }] });
        const reopened = extractFormState({ ...filter, ...on } as unknown as FlowNode).route as Route;
        expect(reopened).toMatchObject({ mode: 'items', keepRest: true });
        expect(reopened.rules).toHaveLength(1);
        expect(edit({ ...filter, ...on }, (r) => keepRestPatch(r, false, outputName))).toMatchObject({ type: 'filter', expr: 'item.total > 5' });
    });

    it('drops the box when the node grows to several outputs or collapses back', () => {
        expect(chooseSeveral({ rules: [{ name: 'keep', expr: 'x', value: '' }], keepRest: true }, outputName)).toMatchObject({ keepRest: false });
        expect(collapseToOne({ rules: [] })).toMatchObject({ keepRest: false });
    });

    it('says what happens to the rest, and counts “Otherwise” where it is live (web routeEditorsOutputs)', () => {
        const one = { several: false, fanOut: false, keepRest: false };
        expect(otherwiseSentence(T, { ...one, items: true })).toBe('What matches continues; the rest stops here.');
        expect(otherwiseSentence(T, { ...one, keepRest: true, items: true })).toContain('goes to “Otherwise”');
        // A whole-run Condition decides once: then or else, never "the rest stops here".
        expect(otherwiseSentence(T, { ...one, items: false })).toContain('the run goes to “Otherwise”');
        expect(outputCount(T, 1, false)).toBe('This node has 1 output.');
        expect(outputCount(T, 1, true)).toBe('This node has 1 output plus “Otherwise”.');
        expect(outputCount(T, 3, true)).toBe('This node has 3 outputs.');
    });
});

describe('the outputs', () => {
    it('adds an output; the first crossing to several fans out', () => {
        expect(addRule({ rules: [{ name: 'rule1', expr: '', value: '' }] }, outputName)).toMatchObject({
            matchMode: 'all',
            rules: [{ name: 'Output 1' }, { name: 'Output 2' }],
        });
        const patch = edit(router, (r) => addRule(r, outputName));
        expect(patch.cases).toHaveLength(3);
        expect((patch.cases as { name: string }[])[2]?.name).toBe('Output 3');
        expect(patch.matchMode).toBeUndefined();
    });

    it('carries the "when nothing matches" pick through a rename, and drops it with a removal', () => {
        expect(edit(router, (r) => updateRule(r, 1, { name: 'bills' }))).toMatchObject({ defaultBranch: 'bills' });
        expect(edit(router, (r) => removeRule(r, 1))).toMatchObject({ type: 'condition' });
        const three = { ...router, cases: [...router.cases, { name: 'other', expr: 'true' }] };
        expect(edit(three, (r) => removeRule(r, 1)).defaultBranch).toBeNull();
    });

    it('turns a legacy value switch into full conditions, losslessly', () => {
        const legacy = { id: 's2', type: 'switch', expr: 'trigger.output.kind', routeStyle: 'value', cases: [{ name: 'a', value: 'x' }, { name: 'b', value: 3 }] };
        const patch = edit(legacy, convertToConditions);
        expect(patch.cases).toEqual([
            { name: 'a', expr: 'trigger.output.kind == "x"' },
            { name: 'b', expr: 'trigger.output.kind == 3' },
        ]);
        expect(patch.routeStyle).toBe('rules');
    });

    it('keeps a per-item rule as a filter over its list', () => {
        const filter = { id: 'f1', type: 'filter', arrayRef: 'steps.s.output.rows', expr: '' };
        const patch = edit(filter, (r) => updateRule(r, 0, { expr: 'item.total > 5' }));
        expect(patch).toMatchObject({ expr: 'item.total > 5' });
        expect(edit(filter, () => ({ mode: 'branch' }))).toMatchObject({ type: 'condition', arrayRef: undefined });
    });

    it('knows which outputs are wired, and checks a new name', () => {
        const edges = [
            { from: 's1', to: 'a', label: 'case:urgent' },
            { from: 's1', to: 'b', caseName: 'invoice', label: 'case:invoice' },
            { from: 'x', to: 's1', label: 'case:nope' },
        ];
        expect([...wiredCaseNames(edges, 's1')]).toEqual(['urgent', 'invoice']);
        expect(checkCaseName(' bills ', 'invoice', ['urgent'])).toEqual({ name: 'bills' });
        expect(checkCaseName('  ', 'invoice', [])).toEqual({ error: 'required', name: 'invoice' });
        expect(checkCaseName('urgent', 'invoice', ['urgent'])).toEqual({ error: 'taken', name: 'urgent' });
    });
});

describe('the condition builder', () => {
    it('opens a fresh `true` as one blank row, and grammar the rows lack as raw text', () => {
        expect(isTrivialValue(' true ')).toBe(true);
        // A new row's operator is "is" (R6).
        expect(conditionState('true')).toMatchObject({ raw: false, join: '&&', rows: [{ op: 'is' }] });
        const parsed = conditionState('trigger.output.a > 1 || trigger.output.b == "x"');
        expect(parsed).toMatchObject({ raw: false, join: '||' });
        expect(parsed.rows).toHaveLength(2);
        expect(conditionState('a > 1 && b > 2 || c').raw).toBe(true);
        expect(canUseVisual('')).toBe(true);
    });

    it('notes a whole list compared as one value — not with a quantifier — and never leaves no row', () => {
        const rows = [{ field: { kind: 'ref' as const, path: 'item.rows[*].a' }, op: 'eq', value: { kind: 'literal' as const, value: 1 } }];
        expect(readsListAsValue(rows[0]!)).toBe(true);
        expect(readsListAsValue({ ...rows[0]!, op: 'truthy' })).toBe(false);
        expect(readsListAsValue({ ...rows[0]!, quantifier: 'any' })).toBe(false);
        expect(withoutRow(rows, 0)).toHaveLength(1);
    });

    it('reads a field typed as an expression as a reference or a formula, never as fixed text', () => {
        expect(fieldFromExpression('steps.x.output.total')).toEqual({ kind: 'ref', path: 'steps.x.output.total' });
        // The roots a per-item rule is written in, which the web's bindingFromInput does not know.
        expect(fieldFromExpression(' item.amount ')).toEqual({ kind: 'ref', path: 'item.amount' });
        expect(fieldFromExpression('_index')).toEqual({ kind: 'ref', path: '_index' });
        expect(fieldFromExpression('secrets.token')).toEqual({ kind: 'ref', path: 'secrets.token' });
        expect(fieldFromExpression('item.amount > 5')).toEqual({ kind: 'expr', value: 'item.amount > 5' });
        expect(fieldFromExpression('len(trigger.output.rows)')).toEqual({ kind: 'expr', value: 'len(trigger.output.rows)' });
        // Empty is the blank row's empty reference, which the serialiser drops.
        expect(fieldFromExpression('  ')).toEqual({ kind: 'ref', path: '' });
    });

    it('writes a field back as the expression it is — fixed text quoted, empty as empty', () => {
        expect(fieldAsExpression({ kind: 'ref', path: 'item.amount' })).toBe('item.amount');
        expect(fieldAsExpression({ kind: 'expr', value: 'len(item.tags)' })).toBe('len(item.tags)');
        expect(fieldAsExpression({ kind: 'literal', value: 'steps.x.output.total' })).toBe('"steps.x.output.total"');
        expect(fieldAsExpression({ kind: 'template', value: '{{item.a}}' })).toBe('item.a');
        expect(fieldAsExpression({ kind: 'literal', value: '' })).toBe('');
        expect(fieldAsExpression(null)).toBe('');
        for (const text of ['steps.x.output.total', 'item.amount > 5', '']) expect(fieldAsExpression(fieldFromExpression(text))).toBe(text);
    });
});

describe('the fields a rule is built from', () => {
    it('lists an item’s fields one level deep, and every upstream field by step', () => {
        expect(itemFieldOptions({ subject: 'Hi', from: { email: 'a@b' } }, 'message', T).map((o) => [o.path, o.label, o.group])).toEqual([
            ['item.subject', 'Subject', 'Fields of each message'],
            ['item.from', 'From', 'Fields of each message'],
            ['item.from.email', 'From · Email', 'Fields of each message'],
        ]);
        const groups = [{ id: 'g', label: 'Search', kind: 'step', basePath: 'steps.g.output', sample: {}, fields: [{ key: 'total', path: 'steps.g.output.total', sample: 3 }] }];
        expect(upstreamFieldOptions(groups)).toEqual([{ path: 'steps.g.output.total', label: 'Total', sample: 3, group: 'Search' }]);
        const scope = itemScope({ a: 1 }, { groups, sampleRoot: { steps: {} } }, 'Current item');
        expect(scope?.groups[0]).toMatchObject({ basePath: 'item', label: 'Current item' });
        expect(scope?.sampleRoot).toEqual({ steps: {}, item: { a: 1 } });
        expect(itemScope(null, { groups, sampleRoot: null }, 'x')).toBeNull();
    });

    it('names a Condition output by its own label, never matchesByCase', () => {
        const fields = [
            { key: 'matchesByCase.pdf', path: 'steps.sw.output.matchesByCase.pdf', sample: [], label: 'pdf', children: [{ key: 'size', path: 'steps.sw.output.matchesByCase.pdf[*].size', sample: 1 }] },
            { key: 'matchesByCase.default', path: 'steps.sw.output.matchesByCase.default', sample: [], label: 'Otherwise', labelKey: 'condition_node.otherwise.label' },
        ];
        const groups = [{ id: 'sw', label: 'Sort', kind: 'switch', basePath: 'steps.sw.output', sample: {}, fields }];
        expect(upstreamFieldOptions(groups).map((o) => o.label)).toEqual(['pdf', 'pdf · Size', 'Otherwise']);
    });

    it('offers a list of records once, and its columns only in their own group with File type first (R1)', () => {
        const mail = { subject: 'Invoice', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf' }] };
        const options = itemFieldOptions(mail, 'message', T);
        expect(options.map((o) => [o.path, o.group, o.kind ?? null, o.quantified ?? null])).toEqual([
            ['item.subject', 'Fields of each message', null, null],
            ['item.attachments', 'Fields of each message', 'records', null],
            ['fileType(item.attachments[*])', 'Attachments of each message', 'fileType', true],
            ['item.attachments[*].filename', 'Attachments of each message', null, true],
            ['item.attachments[*].mimeType', 'Attachments of each message', null, true],
        ]);
        // An attachment itself is a file: File type comes first.
        expect(itemFieldOptions({ filename: 'a.pdf', mimeType: 'application/pdf' }, 'attachment', T)[0]).toMatchObject({ path: 'fileType(item)', label: 'File type' });
    });
});

describe('accepting "Suggest outputs"', () => {
    const WEB = fs.readFileSync(path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow/settings/routeEditors.jsx'), 'utf8');

    it('replaces the outputs, clears the old default, and fans out only when growing from one', () => {
        const one = { rules: [{ name: 'rule1', expr: 'x', value: '' }], defaultBranch: 'rule1' } as unknown as Route;
        const patch = applySuggestion(one, [{ name: 'pdf', expr: 'a' }, { name: 'pdf', expr: 'b' }]);
        expect(patch).toEqual({
            rules: [{ name: 'pdf', expr: 'a', value: '' }, { name: 'pdf_2', expr: 'b', value: '' }],
            style: 'rules',
            defaultBranch: '',
            matchMode: 'all',
        });
        const several = { rules: [{ name: 'a' }, { name: 'b' }], matchMode: 'first' } as unknown as Route;
        expect(applySuggestion(several, [{ name: 'x', expr: 'e' }, { name: 'y', expr: 'f' }]).matchMode).toBeUndefined();
    });

    it('keeps the web handler’s rule', () => {
        expect(WEB).toContain("for (const r of suggested) named.push({ name: uniqueRuleName(named, r.name), expr: r.expr, value: '' });");
        expect(WEB).toContain("...(rules.length <= 1 && named.length > 1 ? { matchMode: 'all' } : null),");
    });

    it('counts against the rows the editor has, and names the wires an accept costs', () => {
        const root = { trigger: { output: { rows: [1, 2] } } };
        expect(sampleRowsFor({ mode: 'items', source: 'trigger.output.rows' } as Route, root)).toEqual([1, 2]);
        expect(sampleRowsFor({ mode: 'records', source: 'trigger.output.rows' } as unknown as Route, root)).toBeNull();
        // Read like the run reads it: a list held as JSON text counts too (R10).
        expect(sampleRowsFor({ mode: 'items', source: 'trigger.output.json' } as Route, { trigger: { output: { json: '[{"a":1},{"a":2}]' } } })).toEqual([{ a: 1 }, { a: 2 }]);
        expect(losingWires(['a', 'b'], [{ name: 'b' }])).toEqual(['a']);
        expect(configuredRules({ rules: [{ name: 'a', expr: ' ' }, { name: 'b', expr: 'x' }] } as unknown as Route)).toBe(1);
    });
});
