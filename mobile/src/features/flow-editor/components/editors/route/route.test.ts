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
import { canUseVisual, conditionState, fieldAsExpression, fieldFromExpression, hasWildcard, isTrivialValue, withoutRow } from './conditionState';
import { itemFieldOptions, itemScope, upstreamFieldOptions } from './fieldOptions';
import {
    addRule,
    applySuggestion,
    checkCaseName,
    chooseSeveral,
    collapseToOne,
    convertToConditions,
    losingOutputs,
    outputLetter,
    removeRule,
    updateRule,
    wiredCaseNames,
    type RoutePatch,
} from './routeEdits';

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
    it('grows a condition to a two-output router that fans out', () => {
        const patch = edit(condition, chooseSeveral);
        expect(patch.type).toBe('switch');
        expect(patch.cases).toEqual([
            { name: 'rule1', expr: 'trigger.output.amount > 10' },
            { name: 'rule2', expr: '' },
        ]);
        expect(patch.matchMode).toBe('all');
    });

    it('does nothing when there already are several', () => {
        expect(chooseSeveral({ rules: router.cases.map((c) => ({ ...c, value: '' })) })).toBeNull();
    });

    it('collapses a router back to a condition, first-match, with no default', () => {
        const patch = edit(router, collapseToOne);
        expect(patch.type).toBe('condition');
        expect(patch.expr).toBe('contains(trigger.output.subject, "urgent")');
        expect(patch.cases).toBeUndefined();
    });

    it('names the wired outputs collapsing would cost', () => {
        const route = extractFormState(router as unknown as FlowNode).route as Route;
        expect(losingOutputs(route, new Set(['invoice', 'nope']))).toEqual([{ letter: 'B', name: 'invoice' }]);
        expect(outputLetter(0)).toBe('A');
        expect(outputLetter(26)).toBe('27');
    });
});

describe('the outputs', () => {
    it('adds an output; the first crossing to several fans out', () => {
        expect(addRule({ rules: [{ name: 'rule1', expr: '', value: '' }] })).toMatchObject({ matchMode: 'all' });
        const patch = edit(router, addRule);
        expect(patch.cases).toHaveLength(3);
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
        expect(conditionState('true')).toMatchObject({ raw: false, join: '&&', rows: [{ op: 'eq' }] });
        const parsed = conditionState('trigger.output.a > 1 || trigger.output.b == "x"');
        expect(parsed).toMatchObject({ raw: false, join: '||' });
        expect(parsed.rows).toHaveLength(2);
        expect(conditionState('a > 1 && b > 2 || c').raw).toBe(true);
        expect(canUseVisual('')).toBe(true);
    });

    it('warns on a whole list compared, and never leaves no row', () => {
        const rows = [{ field: { kind: 'ref' as const, path: 'trigger.output.rows[*].a' }, op: 'eq', value: { kind: 'literal' as const, value: 1 } }];
        expect(hasWildcard(rows)).toBe(true);
        expect(hasWildcard([{ ...rows[0], op: 'truthy' }] as typeof rows)).toBe(false);
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
        expect(itemFieldOptions({ subject: 'Hi', from: { email: 'a@b' } }, 'Fields').map((o) => [o.path, o.label])).toEqual([
            ['item.subject', 'Subject'],
            ['item.from', 'From'],
            ['item.from.email', 'From · Email'],
        ]);
        const groups = [{ id: 'g', label: 'Search', kind: 'step', basePath: 'steps.g.output', sample: {}, fields: [{ key: 'total', path: 'steps.g.output.total', sample: 3 }] }];
        expect(upstreamFieldOptions(groups)).toEqual([{ path: 'steps.g.output.total', label: 'Total', sample: 3, group: 'Search' }]);
        const scope = itemScope({ a: 1 }, { groups, sampleRoot: { steps: {} } }, 'Current item');
        expect(scope?.groups[0]).toMatchObject({ basePath: 'item', label: 'Current item' });
        expect(scope?.sampleRoot).toEqual({ steps: {}, item: { a: 1 } });
        expect(itemScope(null, { groups, sampleRoot: null }, 'x')).toBeNull();
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
        expect(losingWires(['a', 'b'], [{ name: 'b' }])).toEqual(['a']);
        expect(configuredRules({ rules: [{ name: 'a', expr: ' ' }, { name: 'b', expr: 'x' }] } as unknown as Route)).toBe(1);
    });
});
