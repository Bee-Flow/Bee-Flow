/**
 * DIFFERENTIAL lockstep for the discovery review fixes: agent-hub
 * `Builder/mapping/{deepFields.ts, upstream/*}` and their ports give the same
 * answers, and those answers are the fixed ones:
 *   - a `length` key inside JSON text is never offered (the runtime reads the
 *     text's own length there);
 *   - a Code step that runs once per item offers its forEach envelope's
 *     lists, never `result.results` or its `logs`;
 *   - a last run whose shape no longer fits the step ("run once per item"
 *     switched on or off since) leaves the design-time fields standing, and a
 *     per-item run with no output keeps the per-item fields;
 *   - the current item previews ONE item, the first.
 * When this fails the web side changed — update the port, don't loosen the test.
 */

import * as df from '../deepFields';
import { buildRealOutputMap } from '../realOutputs';
import { BUILDER, requireWeb } from '../testing/web';
import type { Catalog, FlowDefinition, VariableField, VariableGroup } from '../types';
import * as up from './index';

const web = {
    df: requireWeb(`${BUILDER}/mapping/deepFields.ts`),
    up: requireWeb(`${BUILDER}/mapping/upstream/index.js`),
    real: requireWeb(`${BUILDER}/mapping/realOutputs.js`),
};

const paths = (fields: VariableField[] | undefined): string[] => {
    const out: string[] = [];
    up.eachField(fields, (f) => out.push(f.path));
    return out;
};

function groupsBoth(def: FlowDefinition, at: string, catalog: Catalog, runSteps: unknown[]) {
    const real = buildRealOutputMap(def, runSteps as Parameters<typeof buildRealOutputMap>[1]);
    const mine = up.computeUpstreamGroups(def, at, catalog, real);
    const theirs = web.up.computeUpstreamGroups?.(def, at, catalog, web.real.buildRealOutputMap?.(def, runSteps));
    expect(mine).toStrictEqual(theirs);
    return mine;
}

describe('a `length` key inside JSON text', () => {
    const BODY = '{"length":120,"width":40}';
    const ROWS = ['{"length":5,"name":"a"}', '{"length":7,"name":"b"}'];

    it('is not offered, on both sides', () => {
        const fields = df.deepValueFields(BODY, 'x');
        expect(fields).toStrictEqual(web.df.deepValueFields?.(BODY, 'x'));
        expect(fields.map((f) => f.path)).toStrictEqual(['x.width']);
        expect(df.listSources({ rows: ROWS }, 'r')).toStrictEqual(web.df.listSources?.({ rows: ROWS }, 'r'));
        expect(df.mergeElementSamples(ROWS)).toStrictEqual({ name: 'a' });
        expect(web.df.mergeElementSamples?.(ROWS)).toStrictEqual({ name: 'a' });
        const root = { steps: { q: { output: { rows: ROWS } } } };
        expect(up.resolveElementSample('steps.q.output.rows', root)).toStrictEqual(web.up.resolveElementSample?.('steps.q.output.rows', root));
    });
});

const CODE_DEF = (perItem: boolean): FlowDefinition => ({
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'src', type: 'integration_action', tool: 'list_tool' },
        { id: 'code', type: 'code', ...(perItem ? { forEach: { overRef: 'steps.src.output.items', itemVar: 'item' } } : {}) },
        { id: 'dst', type: 'notification', title: 'x' },
    ],
    edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 'code' }, { from: 'code', to: 'dst' }],
});
const CODE_CATALOG = { apps: [{ actions: [{ name: 'list_tool', outputSample: { items: [{ id: 1 }] } }] }], triggerOutputs: {} } as unknown as Catalog;
const CODE_RUN = {
    iterations: 2, succeeded: 2, failed: 0,
    results: [{ index: 0, item: { id: 1 }, output: { result: { rows: [{ a: 1 }] }, logs: ['hi'], httpCalls: 0 }, status: 'success' }],
};

describe('lists of a Code step that runs once per item', () => {
    it('are its envelope\'s, on both sides', () => {
        for (const run of [undefined, CODE_RUN]) {
            const groups = groupsBoth(CODE_DEF(true), 'dst', CODE_CATALOG, run ? [{ stepId: 'code', output: run }] : []);
            const root = { steps: { code: { output: run ?? (groups.find((g) => g.id === 'code') as VariableGroup).sample } } };
            const lists = up.collectArrayPaths(groups, root);
            expect(lists).toStrictEqual(web.up.collectArrayPaths?.(groups, root));
            for (const p of lists.map((f) => f.path)) expect(p).not.toMatch(/\.result\.results|logs/);
            const g = groups.find((x) => x.id === 'code') as VariableGroup;
            expect(up.realFieldsOf(g, run ?? g.sample)).toStrictEqual(web.up.realFieldsOf?.(g, run ?? g.sample));
        }
    });

    it('never the logs of a Code step that returned nothing', () => {
        const groups = groupsBoth(CODE_DEF(false), 'dst', CODE_CATALOG, [{ stepId: 'code', output: { logs: ['x'], httpCalls: 0 } }]);
        const g = groups.find((x) => x.id === 'code') as VariableGroup;
        expect(df.groupListSources(g)).toStrictEqual(web.df.groupListSources?.(g));
        expect(df.groupListSources(g).map((s) => s.path)).toStrictEqual([]);
    });
});

describe('"run once per item" switched since the last run', () => {
    const CATALOG = {
        apps: [{ actions: [{ name: 'list_ids', outputSample: { ids: ['m1'] } }, { name: 'get_mail', outputSample: { subject: '', from: '' } }] }],
        triggerOutputs: {},
    } as unknown as Catalog;
    const def = (perItem: boolean): FlowDefinition => ({
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'src', type: 'integration_action', tool: 'list_ids' },
            { id: 'get', type: 'integration_action', tool: 'get_mail', ...(perItem ? { forEach: { overRef: 'steps.src.output.ids', itemVar: 'id' } } : {}) },
            { id: 'dst', type: 'notification', title: 'x' },
        ],
        edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 'get' }, { from: 'get', to: 'dst' }],
    });
    const FLAT = { subject: 'Hi', from: 'x@y' };
    const ENVELOPE = { iterations: 1, succeeded: 1, failed: 0, results: [{ index: 0, item: 'm1', output: FLAT, status: 'success' }] };
    const fieldsOf = (perItem: boolean, run: unknown) =>
        paths((groupsBoth(def(perItem), 'dst', CATALOG, [{ stepId: 'get', output: run }]).find((g) => g.id === 'get') as VariableGroup).fields);

    it('follows the configuration, not the stale run, on both sides', () => {
        expect(fieldsOf(true, FLAT)).toContain('steps.get.output.results[*].output.subject');
        expect(fieldsOf(false, ENVELOPE)).toContain('steps.get.output.subject');
        expect(fieldsOf(true, { iterations: 0, succeeded: 0, failed: 0, results: [] })).toContain('steps.get.output.results[*].output.from');
        expect(fieldsOf(true, { iterations: 1, succeeded: 0, failed: 1, results: [{ index: 0, item: 'm1', status: 'failed' }] }))
            .toContain('steps.get.output.results[*].output.subject');
    });

    it('a step pinned before the switch offers the pin\'s fields, on both sides', () => {
        for (const [perItem, pin] of [[true, FLAT], [false, ENVELOPE]] as const) {
            const d = def(perItem);
            (d.steps || []).forEach((s) => {
                if (s.id === 'get') s.pinnedOutput = pin;
            });
            const fields = paths((groupsBoth(d, 'dst', CATALOG, []).find((g) => g.id === 'get') as VariableGroup).fields);
            expect(fields.some((p) => p.includes('results[*]'))).toBe(!perItem);
        }
    });

    it('a pin keeps its own shape, on both sides', () => {
        for (const [perItem, pin] of [[true, FLAT], [false, ENVELOPE]] as const) {
            const g = up.computeUpstreamGroups(def(perItem), 'dst', CATALOG).find((x) => x.id === 'get') as VariableGroup;
            const mine = up.overlayGroupWithReal(g, pin, { pinned: true });
            expect(mine).toStrictEqual(web.up.overlayGroupWithReal?.(g, pin, { pinned: true }));
            expect(paths(mine.fields).some((p) => p.includes('results[*]'))).toBe(!perItem);
        }
    });
});

describe('the current item', () => {
    const M1 = { id: 'm1', note: '', attachments: [{ id: 'a1' }, { id: 'a2' }], from: { name: 'Ann' } };
    const M2 = { id: 'm2', note: 'urgent', attachments: [{ id: 'a3', mime: 'pdf' }], from: { name: 'Bob', address: 'b@x' } };
    const DEF: FlowDefinition = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'list', type: 'integration_action', tool: 'list_mail' },
            { id: 'each', type: 'integration_action', tool: 'read_mail', forEach: { overRef: 'steps.list.output.value', itemVar: 'mail' } },
        ],
        edges: [{ from: 'trg', to: 'list' }, { from: 'list', to: 'each' }],
    };

    it('is the first item, its gaps filled from the others, on both sides', () => {
        expect(df.firstItemPreview([M1, M2])).toStrictEqual(web.df.firstItemPreview?.([M1, M2]));
        const groups = groupsBoth(DEF, 'each', { apps: [] } as unknown as Catalog, [{ stepId: 'list', output: { value: [M1, M2] } }]);
        const item = groups.find((g) => g.basePath === 'loop.mail') as VariableGroup;
        expect(item.sample).toStrictEqual({ ...M1, from: { name: 'Ann', address: 'b@x' } });
        expect(paths(item.fields)).toContain('loop.mail.attachments[*].mime');
        const root = { steps: { list: { output: { value: [M1, M2] } } } };
        expect(up.inferLoopItemSample('steps.list.output.value', DEF, new Map(), root)).toStrictEqual(
            web.up.inferLoopItemSample?.('steps.list.output.value', DEF, new Map(), root),
        );
    });

    it("is the first item in a Loop body too, on both sides", () => {
        const loop = { id: 'lp', type: 'loop', itemVar: 'mail', overRef: 'steps.list.output.value', body: [] };
        for (const value of [[M1, M2], [3, 4], []]) {
            const preview = { steps: { list: { output: { value } } } };
            const mine = up.computeLoopBodyGroups(loop, 0, { outerGroups: [], previewSample: preview, catalog: null, definition: DEF });
            expect(mine).toStrictEqual(web.up.computeLoopBodyGroups?.(loop, 0, [], preview, null, DEF));
        }
        const preview = { steps: { list: { output: { value: [M1, M2] } } } };
        const item = up.computeLoopBodyGroups(loop, 0, { outerGroups: [], previewSample: preview, catalog: null, definition: DEF })[0] as VariableGroup;
        expect((item.sample as Record<string, unknown>).note).toBe('');
        expect(paths(item.fields)).toContain('loop.mail.attachments[*].mime');
    });
});
