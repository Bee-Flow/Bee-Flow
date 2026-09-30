/**
 * DIFFERENTIAL lockstep for the `Builder/flow/*` modules the bindings layer
 * reads: each port runs beside its agent-hub original on the same fixtures.
 * When this fails the web side changed — update the port, don't loosen the test.
 *
 * The graph-model ones (displayHelpers, routeModel, routeEdges, the step
 * names, terminal types and trigger names) are the model/ ports, which have
 * lockstep tests of their own; the fixtures here were written for the
 * bindings layer and run through them too. The rest live in this folder
 * because only the bindings layer reads them.
 */

import * as be from '@/features/flow-editor/model/branchEdges';
import * as dh from '@/features/flow-editor/model/displayHelpers';
import { reconcileRouteEdges } from '@/features/flow-editor/model/route/routeEdges';
import * as rm from '@/features/flow-editor/model/route/routeModel';
import { ROUTE_STEP_NAME, SET_STEP_NAME } from '@/features/flow-editor/model/stepDisplayName';
import { isTerminalStepType, TERMINAL_STEP_TYPES } from '@/features/flow-editor/model/terminalSteps';
import { defaultTriggerLabel, TRIGGER_NAME } from '@/features/flow-editor/model/triggerLabels';

import { summariseData } from './dataSummary';
import * as dt from './datetimeTarget';
import { getLayerContract } from './flowletScope';
import { pickSourceById, pickSourcesSync, resetPickSources, setPickSources } from './pickSources';
import * as pm from './privacyModel';
import * as so from './setOperations';
import { paramsToSchema, schemaToParams } from './triggerSchemaUtils';
import { BUILDER, requireWeb, webValue } from '../testing/web';
import type { FlowDefinition, FlowEdge, FlowNode } from '../types';

const flow = (name: string) => requireWeb(`${BUILDER}/flow/${name}.js`);

describe('displayHelpers', () => {
    const web = flow('displayHelpers');
    it.each([
        '', 'subject', 'from_email', 'messageId', 'htmlUrl', 'pdf_file', 'gmail-search', 'a.b.c', 'ALL_CAPS',
        'github_repo_name', '  spaced  ', 'x', '123abc', 'items[0].id', 'results[*].from_email', 'a.', '[0]',
        'ms_teams_ai_tts', null, undefined, 7,
    ])('%p', (key) => {
        expect(dh.humanizeFieldKey(key)).toBe(web.humanizeFieldKey?.(key));
        expect(dh.humanizeFieldTail(key)).toBe(web.humanizeFieldTail?.(key));
        expect(dh.humanizeToolName(key)).toBe(web.humanizeToolName?.(key));
    });
});

describe('dataSummary', () => {
    const web = flow('dataSummary');
    it.each([
        null, undefined, [], [1, 2], [{ a: 1 }, { a: 2 }, null], { results: [{ a: 1 }], total: 201 },
        { results: [1, 2], total: 2 }, { results: [{}], total: 1.5 }, { lines: [{}], total: 100 }, { a: [1], b: [2] },
        { branches: [1], x: 1 }, {}, { a: 1 }, '', 'short', 'x'.repeat(80), 3, true, { rows: [], total: 5 },
    ])('summariseData(%p)', (v) => {
        expect(summariseData(v)).toStrictEqual(web.summariseData?.(v));
    });
});

describe('setOperations', () => {
    const web = flow('setOperations');
    const OPS = [
        { op: 'rowId', target: 'n' }, { op: 'groupId', target: 'g', keys: ['a'] }, { op: 'rename', from: 'a', to: 'b' },
        { op: 'rename', from: 'b', to: 'b' }, { op: 'rename', from: 'zz', to: 'y' }, { op: 'keep', keys: ['b', 'n', 'q'] },
        { op: 'keep', keys: [] }, { op: 'remove', keys: ['n'] }, { op: 'sort', key: 'b' }, null, 'junk',
        { op: 'rowId', target: ' ' }, { op: 'remove', keys: [] },
    ];
    it('folds rows and columns like the web', () => {
        for (let n = 0; n <= OPS.length; n++) {
            const ops = OPS.slice(0, n);
            expect(so.applyOpsToSampleRow({ a: 1, c: 2 }, ops)).toStrictEqual(web.applyOpsToSampleRow?.({ a: 1, c: 2 }, ops));
            expect(so.columnsAfterOps(['a', 'c', 'a', ''], ops)).toStrictEqual(web.columnsAfterOps?.(['a', 'c', 'a', ''], ops));
            expect(so.columnsAfterOps(['a', 'c'], OPS, n)).toStrictEqual(web.columnsAfterOps?.(['a', 'c'], OPS, n));
        }
        expect(so.applyOpsToSampleRow(null, null)).toStrictEqual(web.applyOpsToSampleRow?.(null, null));
        expect(so.applyOpsToSampleRow([1], OPS)).toStrictEqual(web.applyOpsToSampleRow?.([1], OPS));
        expect(so.columnsAfterOps(null, 'x')).toStrictEqual(web.columnsAfterOps?.(null, 'x'));
    });
});

describe('datetimeTarget', () => {
    const web = flow('datetimeTarget');
    const STEPS = [
        null, {}, { target: ' day ' }, { target: '  ' }, { op: 'extract', part: 'month' }, { op: 'extract' },
        { op: 'diff' }, { op: 'format' }, { op: 'add' }, { arrayRef: '' }, { arrayRef: 'x' },
    ];
    it.each(STEPS)('%p', (step) => {
        expect(dt.datetimeTargetColumn(step as never)).toBe(web.datetimeTargetColumn?.(step));
        expect(dt.isDateTimeListMode(step as never)).toBe(web.isDateTimeListMode?.(step));
    });
    it.each([
        '', 'steps.x.output.results[*].updated', 'steps.x.output.results[*]', '[*].a', 'a[*].b[*].c', 'plain', null,
    ])('splitWildcardPath / dateInputPatch(%p)', (p) => {
        expect(dt.splitWildcardPath(p)).toStrictEqual(web.splitWildcardPath?.(p));
        expect(dt.dateInputPatch(p)).toStrictEqual(web.dateInputPatch?.(p));
        expect(dt.dateInputPatch(p, { listMode: true })).toStrictEqual(web.dateInputPatch?.(p, { listMode: true }));
    });
});

describe('small tables', () => {
    it('step names, terminal types and trigger names', () => {
        const names = flow('stepDisplayName');
        expect(SET_STEP_NAME).toBe(webValue(names, 'SET_STEP_NAME'));
        expect(ROUTE_STEP_NAME).toBe(webValue(names, 'ROUTE_STEP_NAME'));
        const terminal = flow('terminalSteps');
        expect([...TERMINAL_STEP_TYPES]).toStrictEqual([...webValue<Set<string>>(terminal, 'TERMINAL_STEP_TYPES')]);
        for (const t of ['stop_error', 'return_to_app', 'set', 7, null]) {
            expect(isTerminalStepType(t)).toBe(terminal.isTerminalStepType?.(t));
        }
        const labels = flow('triggerLabels');
        expect(TRIGGER_NAME).toStrictEqual(webValue(labels, 'TRIGGER_NAME'));
        for (const k of ['form', 'schedule', 'nope', undefined]) {
            expect(defaultTriggerLabel(k)).toBe(labels.defaultTriggerLabel?.(k));
        }
        // The one deliberate difference: the web answers a prototype key with
        // the prototype's function; the port reads own keys only.
        expect(defaultTriggerLabel('toString')).toBe('Manual');
    });

    it('pick sources start empty, as the web cache does', () => {
        const web = flow('pickSourceCatalog');
        resetPickSources();
        expect(pickSourceById('mail')).toBe(web.pickSourceById?.('mail'));
        expect(pickSourcesSync()).toStrictEqual(web.pickSourcesSync?.());
        setPickSources([{ id: 'mail', app: 'gmail' }]);
        expect(pickSourceById('mail')).toStrictEqual({ id: 'mail', app: 'gmail' });
        setPickSources('junk');
        expect(pickSourcesSync()).toStrictEqual([]);
        resetPickSources();
    });

    it('flowlet contracts', () => {
        const web = flow('flowletScope');
        const def: FlowDefinition = {
            layers: {
                a: { trigger: { id: 't', params: [{ name: 'x', type: 'string' }] }, steps: [{ id: 'o', type: 'layer_output', fields: { y: 1, z: 2 } }] },
                b: { steps: [{ id: 's', type: 'set' }] },
            },
        };
        for (const key of ['a', 'b', 'missing', undefined]) {
            expect(getLayerContract(def, key)).toStrictEqual(web.getLayerContract?.(def, key));
        }
        expect(getLayerContract(null, 'a')).toStrictEqual(web.getLayerContract?.(null, 'a'));
    });

    it('trigger params <-> schema', () => {
        const web = flow('triggerSchemaUtils');
        const params = [
            { name: 'a', type: 'number', required: true, description: 'A' }, { name: 'b' }, null, { type: 'x' },
        ];
        expect(paramsToSchema(params)).toStrictEqual(web.paramsToSchema?.(params));
        expect(paramsToSchema(null)).toStrictEqual(web.paramsToSchema?.(null));
        for (const schema of [paramsToSchema(params), null, { properties: { q: null, r: { type: 'boolean' } } }, 'x']) {
            expect(schemaToParams(schema)).toStrictEqual(web.schemaToParams?.(schema));
        }
    });
});

const ROUTE_STEPS: FlowNode[] = [
    { id: 'c', type: 'condition', expr: 'a > 1' },
    { id: 'c0', type: 'condition' },
    { id: 'f', type: 'filter', arrayRef: 'steps.x.output.items', expr: 'item.ok', maxItems: 5 },
    { id: 'f0', type: 'filter' },
    { id: 's1', type: 'switch', cases: [{ name: 'a', expr: 'x' }, { name: 'b', expr: 'y' }], defaultBranch: 'a' },
    { id: 's2', type: 'switch', expr: 'item.kind', arrayRef: '', cases: [{ name: 'a', value: 'A' }, { name: 'b', value: 0 }] },
    { id: 's3', type: 'switch', cases: [{ name: 'a', expr: 'x' }, { name: 'b', expr: '', value: '' }], matchMode: 'all' },
    { id: 's4', type: 'switch', routeStyle: 'value', cases: [{ name: 'a', expr: 'x' }, null as never, { expr: 'z' }], maxItems: 3 },
    { id: 's5', type: 'switch', cases: [] },
    { id: 's6', type: 'switch', cases: [{ name: 'a', expr: 'x' }, { name: 'b', value: 'v' }], matchMode: 'first' },
];

describe('routeModel', () => {
    const web = flow('routeModel');
    it('ROUTE_STEP_TYPES', () => {
        expect([...rm.ROUTE_STEP_TYPES]).toStrictEqual([...webValue<Set<string>>(web, 'ROUTE_STEP_TYPES')]);
    });

    it.each(ROUTE_STEPS.map((s) => [s.id, s]))('read / write / ports %s', (_id, step) => {
        const model = rm.readRoute(step);
        expect(model).toStrictEqual(web.readRoute?.(step));
        expect(rm.readMatchMode(step)).toBe(web.readMatchMode?.(step));
        expect(rm.isRouteStep(step)).toBe(web.isRouteStep?.(step));
        expect(rm.routePorts(step)).toStrictEqual(web.routePorts?.(step));
        for (const variant of routeVariants(model)) {
            expect(rm.writeRoute(variant)).toStrictEqual(web.writeRoute?.(variant));
        }
        for (const edge of EDGES) expect(rm.slotForEdge(step, edge)).toStrictEqual(web.slotForEdge?.(step, edge));
    });

    it('helpers', () => {
        expect(rm.readRoute(null)).toStrictEqual(web.readRoute?.(null));
        expect(rm.emptyRule()).toStrictEqual(web.emptyRule?.());
        expect(rm.emptyRule('x')).toStrictEqual(web.emptyRule?.('x'));
        const rules = [{ name: 'rule' }, { name: 'rule_2' }, null];
        for (const base of [undefined, 'rule', 'other']) {
            expect(rm.uniqueRuleName(rules, base)).toBe(web.uniqueRuleName?.(rules, base));
        }
        expect(rm.uniqueRuleName(null)).toBe(web.uniqueRuleName?.(null));
        expect(rm.isRouteStep(null)).toBe(web.isRouteStep?.(null));
    });
});

const EDGES = [
    { from: 'x', to: 'y' }, { from: 'x', to: 'y', label: 'then' }, { from: 'x', to: 'y', label: 'else' },
    { from: 'x', to: 'y', label: 'case:a' }, { from: 'x', to: 'y', caseName: 'b' }, { from: 'x', to: 'y', label: 'case:default' },
    { from: 'x', to: 'y', label: 'case:zz' }, { from: 'x', to: 'y', label: 'on_error' }, null,
];

function routeVariants(model: rm.Route): Partial<rm.Route>[] {
    const rules = [...model.rules, { name: 'extra', expr: 'q', value: 'v' }];
    return [
        model,
        { ...model, mode: 'items', source: 'steps.a.output.list' },
        { ...model, style: 'value', matchOn: 'item.k' },
        { ...model, rules, matchMode: 'all', defaultBranch: 'extra' },
        { ...model, rules, mode: 'items', maxItems: 7, defaultBranch: 'nope' },
        { ...model, rules: [{ name: ' ', expr: 'e', value: '' }] },
        { ...model, rules: [] },
        { mode: 'items', style: 'rules' },
    ];
}

describe('routeEdges', () => {
    const web = flow('routeEdges');
    const branch = flow('branchEdges');
    it('edge helpers', () => {
        for (const e of EDGES.filter(Boolean) as never[]) {
            expect(be.edgeKey(e)).toBe(branch.edgeKey?.(e));
            expect(be.copyExtraEdgeKeys({ ...(e as object), color: 'red' }, { from: 'a' })).toStrictEqual(
                branch.copyExtraEdgeKeys?.({ ...(e as object), color: 'red' }, { from: 'a' }),
            );
        }
        expect(be.copyExtraEdgeKeys(null, { from: 'a' })).toStrictEqual(branch.copyExtraEdgeKeys?.(null, { from: 'a' }));
    });

    it.each(ROUTE_STEPS.map((s) => [s.id, s]))('reconcile from %s', (_id, prev) => {
        const edges = [
            ...EDGES.filter(Boolean).map((e) => ({ ...(e as FlowEdge), from: prev.id, color: 'blue' })),
            { from: prev.id, to: 'y', label: 'then' }, { from: 'other', to: 'y' },
        ] as FlowEdge[];
        const model = rm.readRoute(prev);
        for (const variant of routeVariants(model)) {
            const next = { ...prev, ...rm.writeRoute(variant) } as FlowNode;
            const def = { steps: [next], edges };
            expect(reconcileRouteEdges(def, prev.id, prev, next)).toStrictEqual(
                web.reconcileRouteEdges?.(def, prev.id, prev, next),
            );
        }
        expect(reconcileRouteEdges({ edges }, prev.id, prev, prev)).toStrictEqual(
            web.reconcileRouteEdges?.({ edges }, prev.id, prev, prev),
        );
        expect(reconcileRouteEdges({}, '', prev, prev)).toStrictEqual({});
    });
});

describe('privacyModel', () => {
    const web = flow('privacyModel');
    const STEPS = [
        { id: 'g', type: 'guard', sourceRef: 'x', onFound: { stop: true, mask: true } },
        { id: 'g2', type: 'guard', onFound: { tokenize: true }, categories: ['Person'], confidence: 0.4 },
        { id: 't', type: 'tokenize', categories: [] }, { id: 'u', type: 'untokenize' }, { id: 'n', type: 'guard', onFound: 'x' },
    ];
    it('mode table', () => {
        const modes = webValue<{ id: string; type: string }[]>(web, 'PRIVACY_MODES');
        expect(pm.PRIVACY_MODE_TYPES.map(([id, type]) => ({ id, type }))).toStrictEqual(
            modes.map((m) => ({ id: m.id, type: m.type })),
        );
        expect([...pm.PRIVACY_STEP_TYPES]).toStrictEqual([...webValue<Set<string>>(web, 'PRIVACY_STEP_TYPES')]);
    });

    it.each(STEPS.map((s) => [s.id, s]))('%s', (_id, step) => {
        const model = pm.readPrivacy(step as FlowNode);
        expect(model).toStrictEqual(web.readPrivacy?.(step));
        expect(pm.isPrivacyStep(step as FlowNode)).toBe(web.isPrivacyStep?.(step));
        for (const mode of ['check', 'check_hide', 'hide', 'reveal', 'bogus', 3]) {
            const variant = { ...model, mode, stopOnFound: true } as never;
            expect(pm.writePrivacy(variant)).toStrictEqual(web.writePrivacy?.(variant));
            expect(pm.stepTypeForMode(mode)).toBe(web.stepTypeForMode?.(mode));
            expect(pm.modeScans(mode)).toBe(web.modeScans?.(mode));
            expect(pm.modeBranches(mode)).toBe(web.modeBranches?.(mode));
            expect(pm.modeHides(mode)).toBe(web.modeHides?.(mode));
        }
    });

    it('nullish input', () => {
        expect(pm.readPrivacy(null)).toStrictEqual(web.readPrivacy?.(null));
        expect(pm.writePrivacy(null)).toStrictEqual(web.writePrivacy?.(null));
        expect(pm.isPrivacyStep(null)).toBe(web.isPrivacyStep?.(null));
    });
});
