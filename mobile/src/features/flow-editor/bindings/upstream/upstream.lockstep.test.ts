/**
 * DIFFERENTIAL lockstep: agent-hub `Builder/mapping/upstream.ts` and this
 * folder's index.ts bind the SAME core describers (the shared mapping core)
 * to their own client modules, and must describe the same fixture definition
 * identically, step by step. What can still differ is the binding: a group
 * name, the Set step's operations, the form-pick registry, a signature. When
 * this fails, fix the env or the wrapper, don't loosen the test.
 */

import { buildRealOutputMap } from '../realOutputs';
import { CATALOG, chainDefinition } from '../testing/fixture';
import { BUILDER, requireWeb } from '../testing/web';
import type { FlowDefinition, FlowNode, VariableGroup } from '../types';
import * as up from './index';

const web = requireWeb(`${BUILDER}/mapping/upstream.ts`);

beforeAll(() => {
    // triggerMetaSample stamps `firedAt` with the clock.
    jest.useFakeTimers({ now: new Date('2026-03-01T10:00:00Z') });
});
afterAll(() => {
    jest.useRealTimers();
});

const DEF = chainDefinition();
const STEP_IDS = (DEF.steps || []).map((s) => s.id);

describe('computeUpstreamGroups over the whole fixture', () => {
    it.each(STEP_IDS)('groups visible to %s', (id) => {
        expect(up.computeUpstreamGroups(DEF, id, CATALOG)).toStrictEqual(web.computeUpstreamGroups?.(DEF, id, CATALOG));
    });

    it('with real run and pinned outputs folded in', () => {
        const def: FlowDefinition = {
            ...DEF,
            steps: (DEF.steps || []).map((s) => (s.id === 'ai' ? { ...s, pinnedOutput: { urgency: 'high', extra: [{ a: 1 }] } } : s)),
        };
        const runSteps = [
            { stepId: 'search', output: { query: 'real', results: [{ id: 'r1', subject: 'Real', nested: { deep: 1 } }, { id: 'r2' }] } },
            { stepId: 'read', output: { iterations: 2, results: [{ output: { body: 'b' } }] } },
            { stepId: 'trg', output: { subject: 'Fired' } },
            { stepId: 'trg2', output: { body: { y: 2 } } },
            { stepId: 'ai2', output: 'plain answer' },
            { stepId: 'code', output: { __truncated__: true } },
            { stepId: 'wait', parentStepId: 'x', output: { waitedSeconds: 1 } },
            { stepId: 'gone', output: { a: 1 } },
        ];
        const real = buildRealOutputMap(def, runSteps);
        const webReal = requireWeb(`${BUILDER}/mapping/realOutputs.js`).buildRealOutputMap?.(def, runSteps);
        expect(real).toStrictEqual(webReal);
        for (const id of ['read', 'loop', 'setList', 'agg', 'last']) {
            expect(up.computeUpstreamGroups(def, id, CATALOG, real)).toStrictEqual(
                web.computeUpstreamGroups?.(def, id, CATALOG, webReal),
            );
        }
    });

    it('other trigger kinds, and no catalog at all', () => {
        for (const trigger of [
            { id: 't', kind: 'manual' }, { id: 't', kind: 'schedule', schedule: { cron: '0 9 * * *', tz: 'UTC' } },
            { id: 't', kind: 'layer_input', params: [{ name: 'a', type: 'file' }] }, { id: 't', kind: 'app_trigger' },
            { id: 't', kind: 'agent_call' }, { id: 't', kind: 'app_event' }, { id: 't', kind: 'webhook' },
            { id: 't', label: 5 },
        ] as FlowNode[]) {
            const def: FlowDefinition = { trigger, steps: [{ id: 's', type: 'code' }], edges: [{ from: 't', to: 's' }] };
            for (const catalog of [CATALOG, null, { triggerOutputs: {} }]) {
                expect(up.computeUpstreamGroups(def, 's', catalog)).toStrictEqual(web.computeUpstreamGroups?.(def, 's', catalog));
            }
        }
    });

    it('guards, containers and forEach on the current step', () => {
        expect(up.computeUpstreamGroups(null, 'x', CATALOG)).toStrictEqual(web.computeUpstreamGroups?.(null, 'x', CATALOG));
        expect(up.computeUpstreamGroups(DEF, '', CATALOG)).toStrictEqual(web.computeUpstreamGroups?.(DEF, '', CATALOG));
        const empty: FlowDefinition = { steps: [{ id: 'a', type: 'code' }] };
        expect(up.computeUpstreamGroups(empty, 'a', CATALOG)).toStrictEqual(web.computeUpstreamGroups?.(empty, 'a', CATALOG));
        const nested: FlowDefinition = {
            trigger: { id: 't', kind: 'manual' },
            steps: [
                { id: 'lp1', type: 'loop', overRef: 'trigger.output.items' },
                { id: 'lp1/a', type: 'set', forEach: { overRef: 'steps.lp1.output.results' } },
            ],
            edges: [{ from: 't', to: 'lp1' }, { from: 'lp1', to: 'lp1/a' }, { from: 'lp1/a', to: 'lp1/a' }],
        };
        expect(up.computeUpstreamGroups(nested, 'lp1/a', CATALOG)).toStrictEqual(web.computeUpstreamGroups?.(nested, 'lp1/a', CATALOG));
    });
});

describe('the smaller exports', () => {
    const groups = up.computeUpstreamGroups(DEF, 'last', CATALOG);

    it('collectUpstream and buildToolOutputMap', () => {
        expect(up.collectUpstream(DEF, 'last')).toStrictEqual(web.collectUpstream?.(DEF, 'last'));
        expect(up.buildToolOutputMap(CATALOG)).toStrictEqual(web.buildToolOutputMap?.(CATALOG));
        expect(up.buildToolOutputMap(null)).toStrictEqual(web.buildToolOutputMap?.(null));
    });

    it('collectArrayPaths, with and without a preview overlay', () => {
        const preview = { steps: { search: { output: { extra: [1], results: [] } } }, trigger: { output: [] } };
        expect(up.collectArrayPaths(groups)).toStrictEqual(web.collectArrayPaths?.(groups));
        expect(up.collectArrayPaths(groups, preview)).toStrictEqual(web.collectArrayPaths?.(groups, preview));
        expect(up.collectArrayPaths(null)).toStrictEqual(web.collectArrayPaths?.(null));
    });

    it('element samples and field options', () => {
        const root = { steps: { s: { output: { list: [{ a: 1 }, { a: 2 }], empty: [], tags: [[1]] } } } };
        for (const ref of ['steps.s.output.list', 'steps.s.output.empty', 'steps.s.output.tags', ' ', 5, 'steps.s.output.list[*].a']) {
            expect(up.resolveElementSample(ref, root)).toStrictEqual(web.resolveElementSample?.(ref, root));
        }
        for (const el of [{ a: 1, b: [2] }, [1], null, 'x']) {
            expect(up.elementFieldOptions(el)).toStrictEqual(web.elementFieldOptions?.(el));
        }
        expect(up.sampleToFields({ 'line-items': [1], a: { 'b c': 1 } }, 'x')).toStrictEqual(
            web.sampleToFields?.({ 'line-items': [1], a: { 'b c': 1 } }, 'x'),
        );
    });

    it('loop inference and item names', () => {
        const tools = up.buildToolOutputMap(CATALOG);
        for (const ref of [
            'steps.search.output.results', 'steps.read.output.results[*].output.attachments', 'steps.search.output.results[0].tags',
            'steps.search.output', 'steps.nope.output.x', 'steps.last.output.id', 'trigger.output.items', '', 7,
            'steps.search.output.total.x', 'steps.search.output.results[*]',
        ]) {
            expect(up.inferLoopItemSample(ref, DEF, tools)).toStrictEqual(web.inferLoopItemSample?.(ref, DEF, tools));
            const root = { trigger: { output: { items: [{ z: 1 }, 2] } } };
            expect(up.inferLoopItemSample(ref, DEF, tools, root)).toStrictEqual(web.inferLoopItemSample?.(ref, DEF, tools, root));
        }
        for (const key of ['results', 'categories', 'boxes', 'as', 'data', '', null]) {
            expect(up.suggestItemVar(key)).toBe(web.suggestItemVar?.(key));
        }
    });

    it('trigger meta', () => {
        expect(up.triggerMetaSample(DEF)).toStrictEqual(web.triggerMetaSample?.(DEF));
        expect(up.triggerMetaSample(null)).toStrictEqual(web.triggerMetaSample?.(null));
        expect(up.describeTriggerMeta(DEF, {})).toStrictEqual(web.describeTriggerMeta?.(DEF, {}));
    });

    it('overlayGroupWithReal', () => {
        const g = groups.find((x) => x.id === 'search') as VariableGroup;
        for (const real of [undefined, 'text', [1], { results: [{ q: 1 }], extra: { deep: 1 } }, null]) {
            expect(up.overlayGroupWithReal(g, real)).toStrictEqual(web.overlayGroupWithReal?.(g, real));
        }
        const ai2 = groups.find((x) => x.id === 'ai2') as VariableGroup;
        expect(up.overlayGroupWithReal(ai2, 'answer')).toStrictEqual(web.overlayGroupWithReal?.(ai2, 'answer'));
    });

    it('computeLoopBodyGroups', () => {
        const loop: FlowNode = {
            id: 'lp', type: 'loop', itemVar: 'row', overRef: 'steps.search.output.results',
            body: [{ id: 'b1', type: 'integration_action', tool: 'gmail_read' }, { id: 'b2', type: 'set', fields: { x: 1 } }, { id: 'b3', type: 'stop_error' }],
        };
        const preview = { steps: { search: { output: { results: [{ subject: 'S' }] } } } };
        for (const variant of [loop, { ...loop, batchSize: 4 }, { ...loop, itemVar: undefined, overRef: 'nope', body: undefined }]) {
            for (const index of [0, 1, 3]) {
                const scope = { outerGroups: groups.slice(0, 2), previewSample: preview, catalog: CATALOG, definition: DEF };
                expect(up.computeLoopBodyGroups(variant, index, scope)).toStrictEqual(
                    web.computeLoopBodyGroups?.(variant, index, groups.slice(0, 2), preview, CATALOG, DEF),
                );
            }
        }
        const scalar = { ...loop, overRef: 'steps.search.output.total' };
        const scope = { outerGroups: null, previewSample: { steps: { search: { output: { total: [3] } } } }, catalog: null, definition: DEF };
        expect(up.computeLoopBodyGroups(scalar, 0, scope)).toStrictEqual(
            web.computeLoopBodyGroups?.(scalar, 0, null, { steps: { search: { output: { total: [3] } } } }, null, DEF),
        );
    });
});

describe('the describer table', () => {
    it('describeNode on its own', () => {
        const tools = up.buildToolOutputMap(CATALOG);
        for (const node of [null, ...(DEF.steps || []), { ...(DEF.trigger as FlowNode), __isTrigger: true }]) {
            expect(up.describeNode(node, { definition: DEF, toolToOutput: tools, triggerOutputs: CATALOG.triggerOutputs || {} })).toStrictEqual(
                web.describeNode?.(node, DEF, tools, CATALOG.triggerOutputs || {}),
            );
        }
    });
});
