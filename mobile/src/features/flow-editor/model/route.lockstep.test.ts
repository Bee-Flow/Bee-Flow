/**
 * DIFFERENTIAL lockstep: the unified Condition node — route model, edge
 * re-pointing, switch-case surgery, the clickable condition rows and the
 * binding helpers they serialise with — against the web builder's modules.
 */

import { bindingFromInput, detectTemplate, isCleanPath, renderBindingValue } from './route/bindingText';
import * as cm from './route/conditionModel';
import { parseExprToRows } from './route/conditionParse';
import { reconcileRouteEdges } from './route/routeEdges';
import * as rm from './route/routeModel';
import { mergeStepPatchIntoDefinition, reconcileSwitchEdges, uniqueCaseName } from './route/switchCaseOps';
import { clone, FIXTURES } from './testing/fixtures';
import type { FlowDefinition, FlowStep } from './types';

const BUILDER = '../../../../../agent-hub/src/components/automation/Builder';
/* eslint-disable @typescript-eslint/no-require-imports */
const webRoute = require(`${BUILDER}/flow/routeModel.js`);
const webRouteEdges = require(`${BUILDER}/flow/routeEdges.js`);
const webSwitch = require(`${BUILDER}/flow/switchCaseOps.js`);
const webCond = require(`${BUILDER}/utils/conditionModel.js`);
const webBinding = require('../../../../../agent-hub/src/utils/bindingHelpers.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const ROUTE_STEPS: Record<string, unknown>[] = [
    { type: 'condition', expr: 'a > 1' },
    { type: 'condition' },
    { type: 'filter', arrayRef: 'steps.s.output.items', expr: 'item.ok', maxItems: 5 },
    { type: 'filter' },
    { type: 'switch', expr: 'x', cases: [{ name: 'a', value: 1 }, { name: 'b', value: '' }], defaultBranch: 'a' },
    { type: 'switch', cases: [{ name: 'a', expr: 'p' }, { name: 'b', expr: '' }] },
    { type: 'switch', cases: [{ name: 'a', expr: 'p' }, { name: 'b', value: 'v' }] },
    { type: 'switch', cases: [{ name: 'a', expr: 'p' }], routeStyle: 'value', matchMode: 'all', arrayRef: '' },
    { type: 'switch', cases: [{ name: 'a', expr: 'p' }, { name: 'b', expr: 'q' }], routeStyle: 'rules', matchMode: 'ALL' },
    { type: 'switch', cases: 'no', arrayRef: 'steps.x.output' },
    { type: 'switch', cases: [null, { name: '' }, { value: 3 }] },
    { type: 'set' },
];

describe('routeModel', () => {
    it.each(ROUTE_STEPS.map((s) => [JSON.stringify(s), s] as const))('%s', (_label, step) => {
        expect(rm.isRouteStep(step as never)).toBe(webRoute.isRouteStep(step));
        expect(rm.readRoute(step)).toEqual(webRoute.readRoute(step));
        expect(rm.readMatchMode(step)).toBe(webRoute.readMatchMode(step));
        expect(rm.routePorts(step)).toEqual(webRoute.routePorts(step));
        const route = rm.readRoute(step);
        expect(rm.writeRoute(route)).toEqual(webRoute.writeRoute(route));
        for (const edge of [{}, { label: 'then' }, { label: 'else' }, { label: 'case:a' }, { caseName: 'b' }, { caseName: 'default' }, { label: 'case:zz' }, { label: 'x' }]) {
            expect(rm.slotForEdge(step, edge)).toBe(webRoute.slotForEdge(step, edge));
        }
    });

    const EDITS: Partial<rm.Route>[] = [
        { mode: 'items', style: 'rules', rules: [{ name: 'keep', expr: 'x', value: '' }], source: 's', maxItems: 3 },
        { mode: 'items', style: 'rules', rules: [], source: '', maxItems: '' },
        { mode: 'items', style: 'value', matchOn: 'm', rules: [{ name: 'a', expr: '', value: 1 }, { name: ' ', expr: '', value: 2 }], source: 's' },
        { mode: 'items', style: 'rules', matchMode: 'all', rules: [{ name: 'a', expr: 'p', value: '' }, { name: 'b', expr: 'q', value: '' }], defaultBranch: 'b' },
        { mode: 'branch', style: 'rules', rules: [{ name: 'r', expr: 'e', value: '' }] },
        { mode: 'branch', style: 'value', matchOn: '', rules: [{ name: 'r', expr: '', value: undefined }], defaultBranch: 'gone' },
        { mode: 'branch', style: 'rules', matchMode: 'all', rules: [{ name: 'a', expr: 'p', value: '' }, { name: 'b', expr: '', value: '' }] },
        { mode: 'branch', style: 'rules' },
    ];
    it.each(EDITS.map((r, i) => [i, r] as const))('writeRoute edit %i', (_i, route) => {
        expect(rm.writeRoute(route)).toEqual(webRoute.writeRoute(route));
    });

    it('names rules and cases the same way', () => {
        const rules = [{ name: 'rule' }, { name: 'rule_2' }, {}];
        for (const base of [undefined, 'rule', 'x']) {
            expect(rm.uniqueRuleName(rules, base)).toBe(webRoute.uniqueRuleName(rules, base));
            expect(uniqueCaseName(rules, base)).toBe(webSwitch.uniqueCaseName(rules, base));
        }
        expect(rm.uniqueRuleName(null)).toBe(webRoute.uniqueRuleName(null));
        expect(uniqueCaseName([{ name: 'case' }])).toBe(webSwitch.uniqueCaseName([{ name: 'case' }]));
        expect(rm.emptyRule()).toEqual(webRoute.emptyRule());
        expect(rm.emptyRule('x')).toEqual(webRoute.emptyRule('x'));
    });
});

describe('routeEdges and switchCaseOps', () => {
    const sw = (FIXTURES.switchy as FlowDefinition).steps[0] as FlowStep;
    const cond = (FIXTURES.branchy as FlowDefinition).steps[0] as FlowStep;
    const flips: [FlowDefinition, FlowStep, Record<string, unknown>][] = [
        [FIXTURES.branchy as FlowDefinition, cond, { type: 'switch', cases: [{ name: 'r1', expr: 'a' }, { name: 'r2', expr: 'b' }] }],
        [FIXTURES.branchy as FlowDefinition, cond, { type: 'filter', arrayRef: 'x', expr: 'y' }],
        [FIXTURES.branchy as FlowDefinition, cond, { expr: 'changed' }],
        [FIXTURES.switchy as FlowDefinition, sw, { type: 'condition', expr: 'x' }],
        [FIXTURES.switchy as FlowDefinition, sw, { type: 'filter', expr: 'x' }],
        [FIXTURES.switchy as FlowDefinition, sw, { cases: [{ name: 'platinum' }, { name: 'silver' }, { name: 'bronze' }] }],
        [FIXTURES.switchy as FlowDefinition, sw, { cases: [{ name: 'silver' }, { name: 'gold' }, { name: 'bronze' }] }],
        [FIXTURES.switchy as FlowDefinition, sw, { cases: [{ name: 'gold' }] }],
        [FIXTURES.switchy as FlowDefinition, sw, { cases: [{ name: 'gold' }, { name: 'gold' }, { name: 'bronze' }] }],
        [FIXTURES.switchy as FlowDefinition, sw, { cases: sw.cases }],
        [FIXTURES.switchy as FlowDefinition, { ...sw, cases: [{ name: 'gold' }, { name: 'silver' }, { name: 'bronze' }, { name: 'tin' }] }, { cases: [{ name: 'gold' }, { name: 'silver' }, { name: 'bronze' }] }],
        [FIXTURES.multi as FlowDefinition, (FIXTURES.multi as FlowDefinition).steps[3] as FlowStep, { type: 'switch', cases: [{ name: 'k' }, { name: 'l' }] }],
        [FIXTURES.multi as FlowDefinition, (FIXTURES.multi as FlowDefinition).trigger as never, { label: 'Renamed' }],
        [FIXTURES.multi as FlowDefinition, ((FIXTURES.multi as FlowDefinition).triggers as never[])[0] as never, { kind: 'schedule' }],
    ];

    it.each(flips.map((f, i) => [i, f] as const))('merge + reconcile, case %i', (_i, [def, step, patch]) => {
        expect(mergeStepPatchIntoDefinition(clone(def), clone(step), patch)).toEqual(webSwitch.mergeStepPatchIntoDefinition(clone(def), clone(step), patch));
        const next = { ...step, ...patch };
        expect(reconcileRouteEdges(clone(def), step.id, step, next as never)).toEqual(webRouteEdges.reconcileRouteEdges(clone(def), step.id, step, next));
        expect(reconcileSwitchEdges(clone(def), step.id, step.cases, patch.cases)).toEqual(webSwitch.reconcileSwitchEdges(clone(def), step.id, step.cases, patch.cases));
    });

    // Follow the route (W3-W5): the step after a list Condition reads the output it hangs off.
    const SRC = 'steps.rm.output.messages';
    const listDef = (route: Record<string, unknown>, overRef: string, label?: string): FlowDefinition => ({
        steps: [
            { id: 'rm', type: 'action', label: 'Read many' },
            { id: 'c', label: 'Condition', ...route },
            { id: 't', type: 'action', label: 'Read attachment', forEach: { overRef, parents: [{ overRef: overRef.split('[*]')[0] }] },
                inputs: { id: { kind: 'ref', path: 'loop.item.id' }, note: { kind: 'template', value: `{{${overRef.split('[*]')[0]}}}` } } },
        ],
        edges: [{ from: 'rm', to: 'c' }, { from: 'c', to: 't', ...(label ? { label } : {}) }],
    } as never);
    const filter = { type: 'filter', arrayRef: SRC, expr: 'contains(item.subject, "x")' };
    const split = { type: 'switch', arrayRef: SRC, routeStyle: 'rules', cases: [{ name: 'pdf', expr: 'a' }, { name: 'word', expr: 'b' }] };
    const follows: [FlowDefinition, Record<string, unknown>][] = [
        [listDef(filter, 'steps.c.output.items[*].attachments'), { type: 'switch', routeStyle: 'rules', cases: [{ name: 'pdf', expr: 'a' }, { name: 'word', expr: 'b' }], expr: undefined }],
        [listDef(split, 'steps.c.output.matchesByCase.pdf[*].attachments', 'case:pdf'), { cases: [{ name: 'invoices', expr: 'a' }, { name: 'word', expr: 'b' }] }],
        [listDef(split, 'steps.c.output.matchesByCase.pdf[*].attachments', 'case:pdf'), { type: 'filter', cases: undefined, routeStyle: undefined, expr: 'a' }],
        [listDef(filter, 'steps.c.output.items[*].attachments'), { arrayRef: `${SRC}[*].attachments` }],
        [listDef(filter, 'steps.c.output.items[*].attachments'), { arrayRef: 'steps.other.output.rows' }],
        [listDef(filter, 'steps.c.output.items[*].attachments'), { type: 'switch', arrayRef: SRC, routeStyle: 'rules', cases: [{ name: 'Output 1', expr: 'a' }] }],
        [listDef({ type: 'condition', expr: 'x' }, 'steps.rm.output.messages[*].attachments', 'then'), { type: 'filter', arrayRef: SRC }],
        [listDef(split, 'steps.c.output.matchesByCase.word', 'case:word'), { cases: [{ name: 'word', expr: 'b' }] }],
        [listDef(split, 'steps.c.output.matchesByCase.pdf', 'case:pdf'), { cases: [{ name: 'word', expr: 'b' }, { name: 'pdf', expr: 'a' }] }],
        [listDef(filter, 'steps.c.output.items[*].attachments', 'true'), { type: 'condition', arrayRef: undefined }],
    ];
    it.each(follows.map((f, i) => [i, f] as const))('merge follows the route, case %i', (_i, [def, patch]) => {
        const step = def.steps[1] as FlowStep;
        const mine = mergeStepPatchIntoDefinition(clone(def), clone(step), patch);
        expect(mine).toEqual(webSwitch.mergeStepPatchIntoDefinition(clone(def), clone(step), patch));
        if (_i < 4) expect(mine).not.toEqual(def);
    });

    it('a removed or reordered case never moves another output\'s reader; "The whole run" again reads the list', () => {
        const overRef = (d: FlowDefinition) => (d.steps[2] as { forEach: { overRef: string } }).forEach.overRef;
        const removed = listDef(split, 'steps.c.output.matchesByCase.word', 'case:word');
        expect(overRef(mergeStepPatchIntoDefinition(removed, removed.steps[1] as FlowStep, { cases: [{ name: 'word', expr: 'b' }] })))
            .toBe('steps.c.output.matchesByCase.word');
        const reordered = listDef(split, 'steps.c.output.matchesByCase.pdf', 'case:pdf');
        const swapped = mergeStepPatchIntoDefinition(reordered, reordered.steps[1] as FlowStep, { cases: [{ name: 'word', expr: 'b' }, { name: 'pdf', expr: 'a' }] });
        expect(overRef(swapped)).toBe('steps.c.output.matchesByCase.pdf');
        expect(swapped.edges).toEqual(reordered.edges);
        const back = listDef(filter, 'steps.c.output.items[*].attachments', 'true');
        expect(overRef(mergeStepPatchIntoDefinition(back, back.steps[1] as FlowStep, { type: 'condition', arrayRef: undefined })))
            .toBe(`${SRC}[*].attachments`);
    });

    it('leaves the definition alone when nothing changed shape', () => {
        const def = clone(FIXTURES.switchy as FlowDefinition);
        expect(reconcileRouteEdges(def, 'sw', sw, { ...sw, expr: 'other' })).toBe(def);
        expect(reconcileRouteEdges(null, 'sw', sw, sw)).toBeNull();
        expect(reconcileSwitchEdges(def, 'sw', sw.cases, sw.cases)).toBe(def);
        expect(reconcileSwitchEdges(null, 'sw', [], [])).toBeNull();
    });
});

const EXPRS = [
    '', '   ', 'a > 1', 'steps.s1.output.n >= 10 && trigger.output.ok == true', 'x == false || y != "a"',
    'a && b || c', 'contains(item.subject, "isv")', '!contains(item.tags, \'x\')', 'startsWith(item.name, "A")',
    'endsWith(a.b, steps.c.output.d)', 'isEmpty(item.x)', '!isEmpty(item.x)', 'item.a === 1', 'item.a !== null',
    'item.a <= -2.5', 'item.a < 3', 'item.a > "2026-01-01"', 'steps.s1.output.results[*].to', 'true', 'x.y[*] == 1',
    'len(item.a) > 2', '(a > 1', '"unterminated', 'a == "x\\"y"', 'item.a == \'it\'s\'', 'a > 1 && contains(b, "c, d")',
    'a[0].b == vars.limit', 'a == ', 'isEmpty(len(x))', 'contains(len(x), 1)', '!contains(len(x), 1)', 'weird(a, b)',
    'a == {{x}}',
    // The runtime's path grammar: a match segment holding a comma is one
    // field, and a quoted key comes back in the canonical spelling.
    'contains(steps.m.output.h[name="a,b"].value, "x")', '!contains(steps.m.output.h[name="a,b"].value, "x, y")',
    'isEmpty(steps.m.output.h[name="a,b"])', '!isEmpty(steps.m.output.h[name="a,b"])', 'endsWith(steps.m.output.h[name="a,b"].value, "7")',
    "steps.j.output.fields['Story Points'] > 3", "trigger.output['x-y']", 'trigger.output.headers["content-type"] == "json"',
    'contains(a.b, "x", "y")', 'contains(a.b, "x") + 1', '!startsWith(a.b, "x")',
    // Condition node Tier 1: text "is", quantified rows, File type, saved blanks.
    'equals(item.status, "open")', '!equals(item.status, "open")', 'item.status == "Open"', 'item.status != "Open"',
    'equals(item.a, "")', 'item.a == ""', 'item.a != ""', 'equals(item.a)', 'equals(item.a, "x") + 1',
    'anyOf(item.attachments[*].filename, "endsWith", ".pdf")', 'everyOf(item.lines[*].qty, ">", 0)',
    'noneOf(item.labels[*].name, "equals", "spam")', 'anyOf(item.attachments[*].name, "isEmpty")',
    'anyOf(item.attachments[*].name, "!isEmpty")', 'anyOf(item.attachments[*].name, "contains", "")',
    'anyOf(item.attachments[*].name, "bogus", "x")', 'anyOf(item.attachments[*].name, "isEmpty", "x")', '!anyOf(item.a[*].b, "equals", 1)',
    'anyOf(item.attachments[*], "equals", "x")', 'anyOf(item.a[*].b[*].c, "equals", "x")',
    'equals(fileType(item), "pdf")', '!equals(fileType(item), "pdf")', 'anyOf(fileType(item.attachments[*]), "equals", "pdf")',
    'noneOf(fileType(item.attachments[*]), "!equals", "word")', 'equals(fileType(item.name), "pdf")', 'equals(fileType(item.a[*].b), "pdf")',
    'contains(item.attachments[*].mimeType, "pdf")', '!contains(item.attachments[*].mimeType, "pdf")', 'contains(item.attachments[*].mimeType)',
    'startsWith(item.attachments[*].name, "x")', 'contains(item.from, "fabrikam") && anyOf(fileType(item.attachments[*]), "equals", "pdf")',
    "anyOf(item['my list'][*].x, 'contains', 'a')", 'isEmpty(item.attachments)', '!isEmpty(item.attachments)',
];

describe('conditionModel', () => {
    it.each(EXPRS)('parse %j, and serialise the rows back', (expr) => {
        const rows = parseExprToRows(expr);
        expect(rows).toEqual(webCond.parseExprToRows(expr));
        if (rows) expect(cm.serializeRows(rows.rows, rows.join)).toBe(webCond.serializeRows(rows.rows, rows.join));
    });

    it('serialises every row shape the same', () => {
        const fields = [null, '', 'item.a', { kind: 'ref', path: 'item.a' }, { kind: 'expr', value: 'len(x)' }, { kind: 'literal', value: 5 }, { kind: 'template', value: 'x' }];
        const values = [undefined, null, { kind: 'literal', value: null }, { kind: 'literal', value: 'x' }, { kind: 'ref', path: 'a.b' },
            { kind: 'template', value: 'Hi {{trigger.output.name}}!' }, { kind: 'template', value: '{{a.b}}' }, { kind: 'template', value: '{{a + 1}}' },
            { kind: 'template', value: 'plain' }, { kind: 'expr', value: '1+1' }, { kind: 'odd' }, 7];
        const ops = ['is', 'isNot', 'eq', 'neq', 'gt', 'lte', 'contains', 'notContains', 'endsWith', 'isEmpty', 'isNotEmpty', 'isTrue', 'isFalse', 'truthy', 'seq', 'bogus', undefined];
        for (const field of fields) for (const value of values) for (const op of ops) {
            const row = { field, op, value } as never;
            expect(cm.serializeRow(row)).toBe(webCond.serializeRow(row));
        }
        const extras = [{}, { keepBlank: true }, { quantifier: 'any' }, { quantifier: 'every', keepBlank: true }, { quantifier: 'none' }, { quantifier: 'odd' }];
        const qFields = [{ kind: 'ref', path: 'item.attachments[*].name' }, { kind: 'ref', path: 'fileType(item.attachments[*])' }, { kind: 'ref', path: 'fileType(item)' }];
        const qValues = [undefined, { kind: 'literal', value: '' }, { kind: 'literal', value: 'pdf' }, { kind: 'literal', value: null }, { kind: 'ref', path: '' }, { kind: 'expr', value: ' ' }];
        for (const field of qFields) for (const value of qValues) for (const op of ops) for (const extra of extras) {
            const row = { field, op, value, ...extra } as never;
            expect(cm.serializeRow(row)).toBe(webCond.serializeRow(row));
        }
        expect(cm.serializeRow(null)).toBe(webCond.serializeRow(null));
        expect(cm.serializeRows(null)).toBe(webCond.serializeRows(null));
        expect(cm.serializeRows([{ field: 'a', op: 'eq', value: 1 }, { field: 'b', op: 'truthy', value: '' }], '||')).toBe(
            webCond.serializeRows([{ field: 'a', op: 'eq', value: 1 }, { field: 'b', op: 'truthy', value: '' }], '||'),
        );
    });

    it('types, operators and labels match', () => {
        for (const v of [null, undefined, [1], 3, true, {}, '2026-01-01', '2026-01-01T10:00', ' 2026-13-99 ', 'hello', () => 1]) {
            expect(cm.inferType(v)).toBe(webCond.inferType(v));
        }
        const t = (key: string, fallback: string) => `${key}=${fallback}`;
        for (const type of ['string', 'number', 'boolean', 'date', 'array', 'object', 'records', 'fileType', 'unknown', 'weird']) {
            expect(cm.operatorsForType(type)).toEqual(webCond.operatorsForType(type));
            expect(cm.operatorsForType(type, 'seq')).toEqual(webCond.operatorsForType(type, 'seq'));
            expect(cm.operatorsForType(type, 'nope')).toEqual(webCond.operatorsForType(type, 'nope'));
            for (const current of [null, 'eq', 'truthy', 'isTrue']) {
                expect(cm.operatorsForType(type, current, { quantified: true, t })).toEqual(webCond.operatorsForType(type, current, { quantified: true, t }));
            }
            for (const key of ['is', 'isNot', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'isEmpty', 'isNotEmpty', 'seq', 'x']) {
                expect(cm.labelFor(key, type)).toBe(webCond.labelFor(key, type));
                expect(cm.labelFor(key, type, t)).toBe(webCond.labelFor(key, type, t));
            }
        }
        for (const key of ['eq', 'isEmpty', 'truthy', 'x', null]) {
            expect(cm.isUnaryOp(key)).toBe(webCond.isUnaryOp(key));
            expect(cm.getOperator(key)?.key ?? null).toBe(webCond.getOperator(key)?.key ?? null);
        }
        expect(cm.emptyRow()).toEqual(webCond.emptyRow());
    });

    it('translates operator labels under condition_node.op, dates, text and lists apart', () => {
        const t = (key: string, fallback: string) => `${key}=${fallback}`;
        expect(cm.labelFor('gt', 'number', t)).toBe('condition_node.op.gt=greater than');
        expect(cm.labelFor('gt', 'date', t)).toBe('condition_node.op.gt_date=is after');
        expect(cm.labelFor('eq', 'string', t)).toBe('condition_node.op.eq_text=is exactly (same upper/lower case)');
        expect(cm.labelFor('isEmpty', 'records', t)).toBe('condition_node.op.isEmpty_records=has none');
        expect(cm.labelFor('contains', 'date', t)).toBe('condition_node.op.contains=contains');
        expect(cm.labelFor('nope', 'date', t)).toBe('nope');
        expect(cm.operatorsForType('boolean', null, { t })[0]).toEqual({ key: 'isTrue', label: 'condition_node.op.isTrue=is true' });
    });

    const walk = (path: string, root: unknown): unknown => {
        const parts = path.replace(/\[\*\]/g, '.*').split('.');
        let cur: unknown[] = [root];
        for (const p of parts) cur = cur.flatMap((v) => (p === '*' ? (Array.isArray(v) ? v : []) : v && typeof v === 'object' ? [(v as Record<string, unknown>)[p]] : []));
        return path.includes('[*]') ? cur : cur[0];
    };
    const SAMPLE = { item: { subject: 'Hi', amount: 3, when: '2026-01-01', ok: true, tags: ['a'], attachments: [{ name: 'a.pdf', size: 3 }] } };
    const ROW_FIELDS = ['', 'item.subject', 'item.amount', 'item.when', 'item.ok', 'item.tags', 'item.attachments', 'item.attachments[*].name',
        'item.attachments[*].size', 'fileType(item)', 'fileType(item.attachments[*])', 'item.missing'];

    it('rowType and rowForField match', () => {
        for (const path of ROW_FIELDS) {
            const row = { field: { kind: 'ref', path }, op: 'contains', value: { kind: 'literal', value: 'x' } } as never;
            for (const root of [SAMPLE, null]) expect(cm.rowType(row, root, walk)).toBe(webCond.rowType(row, root, walk));
            const type = webCond.rowType(row, SAMPLE, walk);
            for (const start of [cm.emptyRow(), { ...cm.emptyRow(), op: 'gt', quantifier: 'none', keepBlank: true }, { field: null, op: 'endsWith', value: 'v', threshold: 0.5 }]) {
                expect(cm.rowForField(start as never, { kind: 'ref', path }, type)).toEqual(webCond.rowForField(start, { kind: 'ref', path }, type));
            }
        }
    });

    it('deepenRows matches', () => {
        const rowsOf = (expr: string) => webCond.parseExprToRows(expr).rows;
        const cases: [string, string][] = [
            ['anyOf(item.attachments[*].name, "endsWith", ".pdf") && contains(item.from, "x")', 'attachments'],
            ['noneOf(fileType(item.attachments[*]), "equals", "pdf")', 'attachments'],
            ['noneOf(item.attachments[*].name, "endsWith", ".pdf")', 'attachments'],
            ['noneOf(item.attachments[*].size, ">", 3) || everyOf(item.attachments[*].size, "<=", 9)', 'attachments'],
            ['anyOf(item.lines[*].qty, ">", 0) && equals(fileType(item.name), "pdf")', 'attachments'],
            ['equals(fileType(item), "pdf") && trigger.output.ok == true', 'attachments'],
        ];
        for (const [expr, key] of cases) expect(cm.deepenRows(rowsOf(expr), key)).toEqual(webCond.deepenRows(rowsOf(expr), key));
    });
});

describe('binding helpers the condition model writes with', () => {
    const texts = [undefined, null, 5, '', '  ', 'steps.a.output.b', 'loop.item', 'vars.x', 'secrets.k', 'item.a', 'foo.bar',
        'a[*].b', 'a + b', '{{steps.a.output}}', 'Hi {{trigger.output.name}}', '1abc', 'x y',
        'steps.a.output["Story Points"]', "steps.a.output['x-y']", 'trigger.output.headers.content-type', 'total-1',
        'steps.a.output[name="a,b"].value', '{{steps.a.output["x}}y"]}}', 'Hi {{ steps.a.output["b c"] }}!', '{{a + 1}}'];
    it.each(texts.map((t) => [String(t), t] as const))('%s', (_label, text) => {
        expect(isCleanPath(text)).toBe(webBinding.isCleanPath(text));
        expect(detectTemplate(text)).toBe(webBinding.detectTemplate(text));
        expect(bindingFromInput(text, 'expression')).toEqual(webBinding.bindingFromInput(text, 'expression'));
        expect(bindingFromInput(text, 'fixed')).toEqual(webBinding.bindingFromInput(text, 'fixed'));
        expect(renderBindingValue(text)).toBe(webBinding.renderBindingValue(text));
    });
});
