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
        const ops = ['eq', 'neq', 'gt', 'contains', 'notContains', 'isEmpty', 'isNotEmpty', 'isTrue', 'isFalse', 'truthy', 'seq', 'bogus', undefined];
        for (const field of fields) for (const value of values) for (const op of ops) {
            const row = { field, op, value } as never;
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
        for (const type of ['string', 'number', 'boolean', 'date', 'array', 'object', 'unknown', 'weird']) {
            expect(cm.operatorsForType(type)).toEqual(webCond.operatorsForType(type));
            expect(cm.operatorsForType(type, 'seq')).toEqual(webCond.operatorsForType(type, 'seq'));
            expect(cm.operatorsForType(type, 'nope')).toEqual(webCond.operatorsForType(type, 'nope'));
            for (const key of ['eq', 'gt', 'gte', 'lt', 'lte', 'contains', 'x']) expect(cm.labelFor(key, type)).toBe(webCond.labelFor(key, type));
        }
        for (const key of ['eq', 'isEmpty', 'truthy', 'x', null]) {
            expect(cm.isUnaryOp(key)).toBe(webCond.isUnaryOp(key));
            expect(cm.getOperator(key)?.key ?? null).toBe(webCond.getOperator(key)?.key ?? null);
        }
        expect(cm.emptyRow()).toEqual(webCond.emptyRow());
    });

    it('translates operator labels under mobile.flow.op, dates apart', () => {
        const t = (key: string, fallback: string) => `${key}=${fallback}`;
        expect(cm.labelFor('gt', 'number', t)).toBe('mobile.flow.op.gt=greater than');
        expect(cm.labelFor('gt', 'date', t)).toBe('mobile.flow.op.gt_date=is after');
        expect(cm.labelFor('contains', 'date', t)).toBe('mobile.flow.op.contains=contains');
        expect(cm.labelFor('nope', 'date', t)).toBe('nope');
        expect(cm.operatorsForType('boolean', null, t)[0]).toEqual({ key: 'isTrue', label: 'mobile.flow.op.isTrue=is true' });
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
