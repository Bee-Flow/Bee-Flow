import { describe, it, expect } from 'vitest';
import { buildSampleRoot } from './realOutputs';
import {
    computeUpstreamGroups, inferLoopItemSample,
    collectArrayPaths, resolveElementSample, elementFieldOptions,
    computeLoopBodyGroups, sampleToFields, overlayGroupWithReal,
} from './upstream';
import { walkPath } from '../../../../utils/bindingHelpers';
import { composeInlineGraph } from '../flow/inlineFlowlets';

describe('collectArrayPaths', () => {
    const groups = [
        {
            id: 's1', label: 'Gmail', kind: 'integration_action', basePath: 'steps.s1.output',
            fields: [
                { key: 'query', path: 'steps.s1.output.query', sample: 'q' },
                { key: 'results', path: 'steps.s1.output.results', sample: [{ id: 1 }] },
                {
                    key: 'meta', path: 'steps.s1.output.meta', sample: { tags: ['a'] },
                    children: [{ key: 'tags', path: 'steps.s1.output.meta.tags', sample: ['a'] }],
                },
            ],
        },
    ];

    it('finds top-level array fields and nested children arrays', () => {
        const out = collectArrayPaths(groups);
        expect(out).toEqual([
            { key: 'results', path: 'steps.s1.output.results', sample: [{ id: 1 }] },
            { key: 'tags', path: 'steps.s1.output.meta.tags', sample: ['a'] },
        ]);
    });

    it('surfaces arrays that exist only in the previewSample overlay', () => {
        const previewSample = { steps: { s1: { output: { extra: [1, 2] } } } };
        const out = collectArrayPaths(groups, previewSample);
        const extra = out.find(p => p.path === 'steps.s1.output.extra');
        expect(extra).toEqual({ key: 'extra', path: 'steps.s1.output.extra', sample: [1, 2] });
    });

    it('dedupes by path when the overlay repeats a design-time array', () => {
        const previewSample = { steps: { s1: { output: { results: [{ id: 9 }], extra: [1, 2] } } } };
        const out = collectArrayPaths(groups, previewSample);
        const results = out.filter(p => p.path === 'steps.s1.output.results');
        expect(results).toHaveLength(1);
        // design-time sample wins (fields are scanned before the overlay)
        expect(results[0].sample).toEqual([{ id: 1 }]);
        expect(out.map(p => p.path)).toEqual([
            'steps.s1.output.results',
            'steps.s1.output.meta.tags',
            'steps.s1.output.extra',
        ]);
    });
});

describe('resolveElementSample', () => {
    it('resolves a plain array ref to its first element', () => {
        const root = { steps: { s1: { output: { results: [{ a: 1 }] } } } };
        expect(resolveElementSample('steps.s1.output.results', root)).toEqual({ a: 1 });
    });

    it('returns null for an empty array', () => {
        const root = { steps: { s1: { output: { results: [] } } } };
        expect(resolveElementSample('steps.s1.output.results', root)).toBeNull();
    });

    it('returns null when the path does not resolve', () => {
        const root = { steps: { s1: { output: { results: [{ a: 1 }] } } } };
        expect(resolveElementSample('steps.s1.output.nope', root)).toBeNull();
        expect(resolveElementSample('steps.zzz.output.results', root)).toBeNull();
        expect(resolveElementSample('', root)).toBeNull();
        expect(resolveElementSample('steps.s1.output.results', null)).toBeNull();
    });

    it('works through a [*] flatten (element of the flattened array)', () => {
        const root = {
            steps: { s1: { output: { results: [{ tags: ['x', 'y'] }, { tags: ['z'] }] } } },
        };
        // results[*].tags flatten-maps to ['x','y','z'] → first element.
        expect(resolveElementSample('steps.s1.output.results[*].tags', root)).toBe('x');
    });
});

describe('elementFieldOptions', () => {
    it('lists top-level keys of an object element with their samples', () => {
        expect(elementFieldOptions({ email: 'a@b.c', amount: 5 })).toEqual([
            { key: 'email', sample: 'a@b.c' },
            { key: 'amount', sample: 5 },
        ]);
    });

    it('returns [] for scalar, array and null elements', () => {
        expect(elementFieldOptions('str')).toEqual([]);
        expect(elementFieldOptions(42)).toEqual([]);
        expect(elementFieldOptions([{ a: 1 }])).toEqual([]);
        expect(elementFieldOptions(null)).toEqual([]);
        expect(elementFieldOptions(undefined)).toEqual([]);
    });
});

describe('computeUpstreamGroups — collection ops resolve element shapes', () => {
    const catalog = {
        apps: [{ id: 'x', actions: [{ name: 't1', outputSample: { results: [{ email: 'a@b.c', amount: 5 }] } }] }],
        triggerOutputs: {},
    };
    const mkDefinition = (stepB) => ({
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'A', type: 'integration_action', tool: 't1', inputs: {} },
            stepB,
            { id: 'C', type: 'set', fields: {} },
        ],
        edges: [{ from: 'trg', to: 'A' }, { from: 'A', to: 'B' }, { from: 'B', to: 'C' }],
    });

    it('filter group carries the source element inside items + items[*] children', () => {
        const def = mkDefinition({ id: 'B', type: 'filter', arrayRef: 'steps.A.output.results' });
        const groups = computeUpstreamGroups(def, 'C', catalog);
        // topological order: trigger, A, B (nearest last)
        expect(groups.map(g => g.id)).toEqual(['trg', 'A', 'B']);

        const filterGroup = groups.find(g => g.id === 'B');
        expect(filterGroup.sample).toEqual({ items: [{ email: 'a@b.c', amount: 5 }], count: 0 });

        const items = filterGroup.fields.find(f => f.key === 'items');
        expect(items.children).toEqual([
            { key: 'email', path: 'steps.B.output.items[*].email', sample: 'a@b.c' },
            { key: 'amount', path: 'steps.B.output.items[*].amount', sample: 5 },
        ]);
    });

    it('aggregate group plucks the configured field into values', () => {
        const def = mkDefinition({ id: 'B', type: 'aggregate', arrayRef: 'steps.A.output.results', field: 'email' });
        const groups = computeUpstreamGroups(def, 'C', catalog);
        const agg = groups.find(g => g.id === 'B');
        expect(agg.sample).toEqual({ values: ['a@b.c'], count: 0 });
    });
});

describe('inferLoopItemSample with a sampleRoot', () => {
    it('resolves from the sampleRoot even with no tool outputs at all', () => {
        const sampleRoot = { steps: { B: { output: { items: [{ email: 'x' }] } } } };
        const el = inferLoopItemSample('steps.B.output.items', { steps: [] }, new Map(), sampleRoot);
        expect(el).toEqual({ email: 'x' });
    });

    it('returns null when neither sampleRoot nor tool map can resolve', () => {
        expect(inferLoopItemSample('steps.B.output.items', { steps: [] }, new Map())).toBeNull();
        expect(inferLoopItemSample('steps.B.output.items', { steps: [] }, new Map(), { steps: {} })).toBeNull();
    });
});

describe('computeLoopBodyGroups', () => {
    const previewSample = { trigger: { output: { items: [{ email: 'a@b.c', amount: 5 }] } } };
    const loopStep = { id: 'lp', overRef: 'trigger.output.items', itemVar: 'row', batchSize: 1, body: [] };
    const outerGroups = [{ id: 'trg', label: 'Trigger', kind: 'trigger', basePath: 'trigger.output', sample: {}, fields: [] }];

    it('adds a "current item" group with the resolved element sample and its fields', () => {
        const groups = computeLoopBodyGroups(loopStep, 0, outerGroups, previewSample, null, { steps: [] });
        expect(groups[0]).toBe(outerGroups[0]); // outer groups come first, unchanged
        const itemGroup = groups.find(g => g.id === '__loop_item');
        expect(itemGroup.basePath).toBe('loop.row');
        expect(itemGroup.sample).toEqual({ email: 'a@b.c', amount: 5 });
        expect(itemGroup.fields.map(f => f.key)).toEqual(['email', 'amount']);
    });

    it('a batch (batchSize>1) exposes an array sample with NO per-field suggestions', () => {
        const batched = { ...loopStep, batchSize: 3 };
        const groups = computeLoopBodyGroups(batched, 0, outerGroups, previewSample, null, { steps: [] });
        const itemGroup = groups.find(g => g.id === '__loop_item');
        expect(itemGroup.sample).toEqual([{ email: 'a@b.c', amount: 5 }]);
        expect(itemGroup.fields).toEqual([]);
        expect(itemGroup.label).toMatch(/batch/i);
    });

    it('a later body step sees the REAL output shape of earlier body steps (via describeNode)', () => {
        const withBody = {
            ...loopStep,
            body: [{ id: 'set1', type: 'set', label: 'Build record', fields: { total: { kind: 'literal', value: 0 } } }],
        };
        const groups = computeLoopBodyGroups(withBody, 1, outerGroups, previewSample, null, { steps: [] });
        const priorGroup = groups.find(g => g.id === 'set1');
        expect(priorGroup).toBeTruthy();
        expect(priorGroup.basePath).toBe('steps.set1.output');
        expect(priorGroup.fields.map(f => f.key)).toEqual(['total']);
    });

    it('body step 0 sees NO prior-body groups (nothing has run yet)', () => {
        const withBody = { ...loopStep, body: [{ id: 'set1', type: 'set', fields: {} }] };
        const groups = computeLoopBodyGroups(withBody, 0, outerGroups, previewSample, null, { steps: [] });
        expect(groups.find(g => g.id === 'set1')).toBeUndefined();
    });

    it('an unresolvable overRef falls back to an empty item sample (no throw)', () => {
        const bad = { ...loopStep, overRef: 'trigger.output.nope' };
        const groups = computeLoopBodyGroups(bad, 0, outerGroups, previewSample, null, { steps: [] });
        const itemGroup = groups.find(g => g.id === '__loop_item');
        expect(itemGroup.sample).toEqual({});
        expect(itemGroup.fields).toEqual([]);
    });
});

// ── Non-identifier JSON keys ───────────────────────────
//
// REGRESSION: every ref path used to be built by raw `${base}.${key}`
// concatenation. A JSON key like "line-items" / "content-type" / "2024 rows"
// then produced `…output.line-items`, which the CLIENT walker then previewed
// happily (it skipped the REF_RE check; it is the runtime's own walker since)
// but the RUNTIME rejects outright — bind.js walkPath bails on `!REF_RE.test(path)`.
// A Loop/Filter bound to such a list looked perfect at design time and failed
// every run with "arrayRef did not resolve to an array".
describe('non-identifier keys are emitted in bracket form', () => {
    // Byte-for-byte copy of server/automation/bind.js REF_RE — the runtime gate
    // a builder-emitted path MUST pass.
    const REF_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[(?:[0-9]+|\*|"[^"]*"|'[^']*')\])*$/;

    it('sampleToFields brackets non-identifier keys, at top level and one level down', () => {
        const fields = sampleToFields(
            { ok: 1, 'line-items': 'x', meta: { 'content-type': 'application/json', plain: 1 } },
            'steps.s1.output',
        );
        const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
        expect(byKey.ok.path).toBe('steps.s1.output.ok');
        expect(byKey['line-items'].path).toBe('steps.s1.output["line-items"]');
        const children = Object.fromEntries(byKey.meta.children.map(c => [c.key, c.path]));
        expect(children['content-type']).toBe('steps.s1.output.meta["content-type"]');
        expect(children.plain).toBe('steps.s1.output.meta.plain');
        for (const f of fields) expect(REF_RE.test(f.path), f.path).toBe(true);
    });

    it('the real-data overlay brackets keys too, including the [*] element level', () => {
        const group = overlayGroupWithReal(
            { id: 's1', label: 'HTTP', kind: 'http_request', basePath: 'steps.s1.output', sample: {}, fields: [] },
            { 'line-items': [{ 'unit price': 3, sku: 'a1' }] },
        );
        const f = group.fields.find(x => x.key === 'line-items');
        expect(f.path).toBe('steps.s1.output["line-items"]');
        const childPaths = Object.fromEntries(f.children.map(c => [c.key, c.path]));
        expect(childPaths['unit price']).toBe('steps.s1.output["line-items"][*]["unit price"]');
        expect(childPaths.sku).toBe('steps.s1.output["line-items"][*].sku');
        for (const p of Object.values(childPaths)) expect(REF_RE.test(p), p).toBe(true);
        expect(REF_RE.test(f.path)).toBe(true);
    });

    it('collectArrayPaths offers a runtime-resolvable path for an overlay-only array', () => {
        const groups = [{ id: 's1', kind: 'http_request', basePath: 'steps.s1.output', fields: [] }];
        const previewSample = { steps: { s1: { output: { 'line-items': [{ sku: 'a1' }] } } } };
        const out = collectArrayPaths(groups, previewSample);
        expect(out).toHaveLength(1);
        expect(out[0].path).toBe('steps.s1.output["line-items"]');
        expect(REF_RE.test(out[0].path)).toBe(true);
        // …and it still resolves client-side, so the preview keeps working.
        expect(walkPath(out[0].path, previewSample)).toEqual([{ sku: 'a1' }]);
    });
});

// ── Expanded flowlet (flat ids) ─────────────────────────
//
// REGRESSION: on a canvas with an expanded flowlet the inline steps carry a
// prefixed id (`cl1/s1`) and their bindings are rewritten to
// `steps.cl1/s1.output.x` / `steps.cl1/ltrg.output.email`, with the sample
// keyed `steps['cl1/s1']`. The runtime walker's REF_RE rejects the `/`, so
// once the preview went through it, every value, preview and field list
// inside an expanded flowlet went empty although the decomposed definition
// runs fine. bindingHelpers.walkPath quotes the prefixed id first.
describe('an expanded flowlet previews through its flat ids', () => {
    const catalog = { apps: [], triggerOutputs: {} };
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: {
            enrich: {
                title: 'Enrich',
                trigger: { id: 'ltrg', type: 'trigger', kind: 'layer_input', params: [{ name: 'email' }] },
                steps: [
                    { id: 's1', type: 'set', fields: { total: { kind: 'literal', value: 42 } } },
                    {
                        id: 's2', type: 'set', fields: {
                            fromStep: { kind: 'ref', path: 'steps.s1.output.total' },
                            fromInput: { kind: 'ref', path: 'trigger.output.email' },
                        },
                    },
                ],
                edges: [{ from: 'ltrg', to: 's1' }, { from: 's1', to: 's2' }],
            },
        },
    };
    const { graph } = composeInlineGraph(def, def, new Set(['cl1']), { dims: { width: 240, height: 96 } });
    const s2 = graph.steps.find(s => s.id === 'cl1/s2');

    it('the bindings are rewritten to the flat ids (precondition)', () => {
        expect(s2.fields.fromStep.path).toBe('steps.cl1/s1.output.total');
        expect(s2.fields.fromInput.path).toBe('steps.cl1/ltrg.output.email');
    });

    it('resolves a sibling step through the upstream groups and their sample root', () => {
        const groups = computeUpstreamGroups(graph, 'cl1/s2', catalog);
        const s1 = groups.find(g => g.id === 'cl1/s1');
        expect(s1.basePath).toBe('steps.cl1/s1.output');
        const root = buildSampleRoot(groups);
        expect(walkPath(s1.basePath, root)).toEqual({ total: 42 });
        expect(walkPath(s2.fields.fromStep.path, root)).toBe(42);
        for (const f of s1.fields) expect(walkPath(f.path, root)).toEqual(f.sample);
    });

    it('resolves the rewritten flowlet trigger under its flat id', () => {
        // A real run (or pin) keys the flowlet input by the same flat id.
        const root = { steps: { 'cl1/ltrg': { output: { email: 'a@b.c' } } } };
        expect(walkPath(s2.fields.fromInput.path, root)).toBe('a@b.c');
    });

    it('still rejects what the runtime rejects after the prefixed id', () => {
        const root = { steps: { 'cl1/s1': { output: { 'content-type': 'x', items: [{ a: 1 }] } } } };
        expect(walkPath('steps.cl1/s1.output["content-type"]', root)).toBe('x');
        expect(walkPath('steps.cl1/s1.output.items[*].a', root)).toEqual([1]);
        expect(walkPath('steps.cl1/s1.output.content-type', root)).toBeUndefined();
        expect(walkPath('steps.cl1/s1.output.items.0.a', root)).toBeUndefined();
        // A top-level path is the runtime's walker, untouched.
        expect(walkPath('steps.s1.output.x', { steps: { s1: { output: { x: 1 } } } })).toBe(1);
    });
});
