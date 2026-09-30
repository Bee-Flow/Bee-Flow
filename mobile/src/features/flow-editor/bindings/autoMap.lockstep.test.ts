/**
 * DIFFERENTIAL lockstep: agent-hub `Builder/mapping/autoMapInputs.js` and the
 * port (autoMap + autoMapIteration + autoMapStep) map the same definitions the
 * same way. When this fails the web side changed — update the port, don't
 * loosen the test.
 */

import * as am from './autoMap';
import { tryIterationMapping } from './autoMapIteration';
import { applyAutoMapToStep, autoMapStep } from './autoMapStep';
import { CATALOG, chainDefinition } from './testing/fixture';
import { BUILDER, requireWeb } from './testing/web';
import type { FlowDefinition, FlowNode } from './types';
import { computeUpstreamGroups } from './upstream';

const web = requireWeb(`${BUILDER}/mapping/autoMapInputs.js`);

beforeAll(() => {
    jest.useFakeTimers({ now: new Date('2026-03-01T10:00:00Z') });
});
afterAll(() => {
    jest.useRealTimers();
});

/** trigger → search → <step>, with `step` swapped in. */
function below(step: FlowNode, extraSteps: FlowNode[] = []): FlowDefinition {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'search', type: 'integration_action', tool: 'gmail_search' }, ...extraSteps, step],
        edges: [{ from: 'trg', to: 'search' }, { from: 'search', to: step.id }, { from: step.id, to: 'next', label: 'then' }, { from: step.id, to: 'other', label: 'else' }],
    };
}

const SCENARIOS: FlowNode[] = [
    { id: 'read', type: 'integration_action', tool: 'gmail_read' },
    { id: 'read2', type: 'integration_action', tool: 'gmail_read', inputs: { messageId: { kind: 'literal', value: 'set' } } },
    { id: 'read3', type: 'integration_action', tool: 'gmail_read', forEach: { overRef: 'x' } },
    { id: 'send', type: 'integration_action', tool: 'gmail_send', inputs: { subject: { kind: 'literal', value: '' } } },
    { id: 'unknownTool', type: 'integration_action', tool: 'nope', inputs: { query: null, total: { kind: 'ref', path: '' } } },
    { id: 'ai', type: 'ai_step', inputs: { query: { kind: 'literal', value: '' }, apiKey: null, other: null } },
    { id: 'ai0', type: 'ai_step' },
    { id: 'layer', type: 'call_layer', layerKey: 'sub', inputs: {} },
    { id: 'layerNone', type: 'call_layer', layerKey: 'nope', inputs: { total: null } },
    { id: 'guard', type: 'guard' },
    { id: 'guardSet', type: 'guard', sourceRef: 'steps.x.output' },
    { id: 'tok', type: 'tokenize', sourceRef: '  ' },
    { id: 'set', type: 'set' },
    { id: 'setFields', type: 'set', fields: { total: null, query: { kind: 'literal', value: 'kept' } } },
    { id: 'setBlankList', type: 'set', arrayRef: '' },
    { id: 'setOps', type: 'set', operations: [{ op: 'rowId' }], fields: {} },
    { id: 'loop', type: 'loop' },
    { id: 'loopLegacy', type: 'loop', overRef: 'trigger.output.items' },
    { id: 'loopSet', type: 'loop', overRef: 'steps.a.output.x' },
    { id: 'cond', type: 'condition', expr: 'true' },
    { id: 'condSet', type: 'condition', expr: 'x > 1' },
    { id: 'sw', type: 'switch', cases: [{ name: 'a' }] },
    { id: 'swList', type: 'switch', arrayRef: '', cases: [{ name: 'a' }] },
    { id: 'filter', type: 'filter' },
    { id: 'limit', type: 'limit', arrayRef: 'trigger.output.items' },
    { id: 'dedupe', type: 'dedupe', arrayRef: 'steps.custom.output.x' },
    { id: 'agg', type: 'aggregate' },
    { id: 'sum', type: 'summarize' },
    { id: 'code', type: 'code' },
];

describe('applyAutoMapToStep', () => {
    it.each(SCENARIOS.map((s) => [s.id, s]))('%s below a list', (_id, step) => {
        const def = below(step);
        expect(applyAutoMapToStep(def, step.id, CATALOG)).toStrictEqual(web.applyAutoMapToStep?.(def, step.id, CATALOG));
        expect(autoMapStep(step, def, CATALOG, { maxPerStep: 1 })).toStrictEqual(web.autoMapStep?.(step, def, CATALOG, { maxPerStep: 1 }));
    });

    it.each(SCENARIOS.map((s) => [s.id, s]))('%s below a list with real outputs', (_id, step) => {
        const def = below(step);
        const realOutputById = new Map<string, unknown>([['search', { results: [{ messageId: 'r1', body: 'hello', id: 'x' }], total: 1 }]]);
        expect(applyAutoMapToStep(def, step.id, CATALOG, { realOutputById })).toStrictEqual(
            web.applyAutoMapToStep?.(def, step.id, CATALOG, { realOutputById }),
        );
    });

    it('every step of the fixture chain', () => {
        const def = chainDefinition();
        for (const s of def.steps || []) {
            expect(applyAutoMapToStep(def, s.id, CATALOG)).toStrictEqual(web.applyAutoMapToStep?.(def, s.id, CATALOG));
        }
    });

    it('guards', () => {
        const def = below({ id: 'x', type: 'code' });
        expect(applyAutoMapToStep(def, 'missing', CATALOG)).toStrictEqual(web.applyAutoMapToStep?.(def, 'missing', CATALOG));
        expect(autoMapStep(null, def, CATALOG)).toStrictEqual(web.autoMapStep?.(null, def, CATALOG));
        const lone: FlowDefinition = { steps: [{ id: 'a', type: 'loop' }] };
        expect(autoMapStep({ id: 'a', type: 'loop' }, lone, CATALOG)).toStrictEqual(web.autoMapStep?.({ id: 'a', type: 'loop' }, lone, CATALOG));
        const marked = below({ id: 'ai', type: 'ai_step', inputs: { query: null }, autoMapped: ['old'] });
        expect(applyAutoMapToStep(marked, 'ai', CATALOG)).toStrictEqual(web.applyAutoMapToStep?.(marked, 'ai', CATALOG));
    });
});

describe('the matching helpers', () => {
    const groups = computeUpstreamGroups(chainDefinition(), 'last', CATALOG);

    it('autoMapInputs over schemas and bare keys', () => {
        for (const app of CATALOG.apps || []) {
            for (const action of app.actions || []) {
                const schema = action?.inputSchema;
                expect(am.autoMapInputs(schema, {}, groups)).toStrictEqual(web.autoMapInputs?.(schema, {}, groups));
                expect(am.autoMapInputs(schema, { query: 'x' }, groups, { maxPerStep: 2 })).toStrictEqual(
                    web.autoMapInputs?.(schema, { query: 'x' }, groups, { maxPerStep: 2 }),
                );
            }
        }
        const bare = { subject: null, Subject: null, from_email: null, fromEmail: null, total: null, body: null, token: null };
        expect(am.autoMapInputs(null, bare, groups)).toStrictEqual(web.autoMapInputs?.(null, bare, groups));
        expect(am.autoMapInputs(null, bare, [])).toStrictEqual(web.autoMapInputs?.(null, bare, []));
        const typed = { properties: { total: { type: ['null', 'integer'] }, subject: { type: 'number' }, tags: { type: 'array' } } };
        expect(am.autoMapInputs(typed, null, groups)).toStrictEqual(web.autoMapInputs?.(typed, null, groups));
    });

    it('nearest array / scannable refs and small predicates', () => {
        for (let n = 0; n <= groups.length; n += 5) {
            const slice = groups.slice(0, n);
            expect(am.nearestArrayRef(slice)).toBe(web.nearestArrayRef?.(slice));
            expect(am.nearestScannableRef(slice)).toBe(web.nearestScannableRef?.(slice));
        }
        const onlyObjects = [{ id: 'x', label: 'x', kind: 'x', basePath: 'steps.x.output', sample: {}, fields: [{ key: 'n', path: 'p', sample: 1 }] }];
        expect(am.nearestScannableRef(onlyObjects)).toBe(web.nearestScannableRef?.(onlyObjects));
        expect(am.nearestScannableRef(null)).toBe(web.nearestScannableRef?.(null));
        expect(am.nearestArrayRef(null)).toBe(web.nearestArrayRef?.(null));
        for (const v of [null, undefined, [], {}, 'x', 1, true]) expect(am.sampleType(v)).toBe(web.sampleType?.(v));
        for (const k of ['From_Email', 'api-key', 'password', 'clientSecret', 'name', null]) {
            expect(am.normalizeKey(k)).toBe(web.normalizeKey?.(k));
            expect(am.isSecretLikeKey(k)).toBe(web.isSecretLikeKey?.(k));
        }
        for (const tool of ['gmail_read', 'nope']) {
            expect(am.findInputSchemaForTool(CATALOG, tool)).toStrictEqual(web.findInputSchemaForTool?.(CATALOG, tool));
        }
        expect(am.findInputSchemaForTool(null, 'x')).toBe(null);
    });

    it('the iteration fallback on its own', () => {
        const def = below({ id: 'r', type: 'integration_action', tool: 'gmail_read' });
        const local = computeUpstreamGroups(def, 'r', CATALOG);
        const schema = { properties: { messageId: { type: 'string' } }, required: ['messageId'] };
        expect(tryIterationMapping(schema, {}, local, { definition: def, catalog: CATALOG })).toStrictEqual({
            patch: { messageId: { kind: 'ref', path: 'loop.result.id' } },
            forEach: { overRef: 'steps.search.output.results', itemVar: 'result', maxIterations: 100 },
        });
        expect(tryIterationMapping({ properties: {} }, {}, local, { definition: def, catalog: CATALOG })).toBe(null);
        expect(tryIterationMapping(schema, {}, [], { definition: def, catalog: CATALOG })).toBe(null);
        const noMatch = { properties: { zzz: { type: 'number' } }, required: ['zzz'] };
        expect(tryIterationMapping(noMatch, {}, local, { definition: def, catalog: CATALOG })).toBe(null);
    });
});
