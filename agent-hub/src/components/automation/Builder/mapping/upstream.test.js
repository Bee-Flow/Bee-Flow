import { describe, it, expect } from 'vitest';
import { buildSampleRoot } from './realOutputs';
import { computeUpstreamGroups } from './upstream';
import { walkPath } from '../../../../utils/bindingHelpers';
import { composeInlineGraph } from '../flow/inlineFlowlets';

// The describers are tested where they live, in
// server/shared/mapping/upstream/*.test.mjs, and what the builder's own hooks
// change in upstream.env.test.ts. What stays here needs agent-hub modules:
// the canvas' flowlet expansion and the preview walker that quotes its ids.

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
