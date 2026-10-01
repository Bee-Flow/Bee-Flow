import { CATALOG } from '@/features/flow-editor/bindings/testing/fixture';
import type { FlowDefinition } from '@/features/flow-editor/model';
import { clone, loopy, switchy } from '@/features/flow-editor/model/testing/fixtures';

import { connectNodes, connectRefusal, removeConnection } from './connect';

const flow = (): FlowDefinition => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    triggers: [{ id: 'hook', type: 'trigger', kind: 'webhook' }],
    steps: [
        { id: 'a', type: 'set' },
        { id: 'b', type: 'set' },
        { id: 'c', type: 'condition', expr: 'x' },
        { id: 'stop', type: 'stop_error' },
        { id: 'n', type: 'note', text: 'hello' },
        { id: 'loop', type: 'loop', body: [{ id: 'in', type: 'set' }] },
    ],
    edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }],
});

describe('drawing a connection', () => {
    it('adds the edge with its branch, and places every node', () => {
        const def = flow();
        const result = connectNodes(def, { source: 'c', target: 'b', handle: 'else' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.definition.edges).toContainEqual({ from: 'c', to: 'b', label: 'else' });
        expect(result.definition.steps.every((s) => s.position)).toBe(true);
        expect(def.edges).toHaveLength(2);
    });

    it('wires a loop\'s "Done" as a plain edge and its error port as on_error', () => {
        const done = connectNodes(flow(), { source: 'loop', target: 'b', handle: null });
        const error = connectNodes(flow(), { source: 'loop', target: 'b', handle: 'on_error' });
        expect(done.ok && done.definition.edges.at(-1)).toEqual({ from: 'loop', to: 'b' });
        expect(error.ok && error.definition.edges.at(-1)).toEqual({ from: 'loop', to: 'b', label: 'on_error' });
    });

    it.each([
        ['a node to itself', { source: 'a', target: 'a', handle: null }, 'self'],
        ['into a trigger', { source: 'a', target: 'hook', handle: null }, 'no_input'],
        ['into a note', { source: 'a', target: 'n', handle: null }, 'no_input'],
        ['out of a note', { source: 'n', target: 'b', handle: null }, 'no_output'],
        ['into a loop body', { source: 'a', target: 'loop/in', handle: null }, 'nested'],
        ['a condition without a branch', { source: 'c', target: 'b', handle: null }, 'unlabelled'],
        ['out of a stop', { source: 'stop', target: 'b', handle: null }, 'terminal'],
        ['the same line twice', { source: 'a', target: 'b', handle: null }, 'duplicate'],
        ['a cycle', { source: 'b', target: 'a', handle: null }, 'cycle'],
    ])('refuses %s', (_what, request, refusal) => {
        expect(connectRefusal(flow(), request)).toBe(refusal);
        expect(connectNodes(flow(), request)).toEqual({ ok: false, refusal });
    });

    it('lets a secondary trigger start a line', () => {
        expect(connectRefusal(flow(), { source: 'hook', target: 'b', handle: null })).toBeNull();
    });

    it('fills the target\'s inputs from what now flows into it, when the catalog is known', () => {
        // The read runs once per search result (the author's setting): its
        // message id comes from the current result.
        const read = { id: 'read', type: 'integration_action', tool: 'gmail_read', forEach: { overRef: 'steps.search.output.results', itemVar: 'mail' } };
        const def: FlowDefinition = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'search', type: 'integration_action', tool: 'gmail_search' }, read],
            edges: [{ from: 'trg', to: 'search' }],
        };
        const result = connectNodes(def, { source: 'search', target: 'read', handle: null }, { catalog: CATALOG });
        expect(result.ok && result.mapped).toBeGreaterThan(0);
        const bare = connectNodes(def, { source: 'search', target: 'read', handle: null });
        expect(bare.ok && bare.mapped).toBe(0);
        expect(bare.ok && bare.definition.steps[1]?.inputs).toBeUndefined();
        expect(result.ok && result.definition.steps[1]?.inputs).toBeTruthy();
    });

    it('never makes the target run once per item', () => {
        const def: FlowDefinition = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'search', type: 'integration_action', tool: 'gmail_search' }, { id: 'read', type: 'integration_action', tool: 'gmail_read' }],
            edges: [{ from: 'trg', to: 'search' }],
        };
        const result = connectNodes(def, { source: 'search', target: 'read', handle: null }, { catalog: CATALOG });
        expect(result.ok && result.definition.steps[1]?.forEach).toBeUndefined();
    });
});

describe('removing a connection', () => {
    it('removes exactly the branch that was picked', () => {
        const def = clone(switchy);
        const next = removeConnection(def, { from: 'sw', to: 'si', sourceHandle: 'case:silver', defLabel: 'case:silver', defCaseName: null });
        expect(next.edges).toHaveLength(def.edges.length - 1);
        expect(next.edges.some((e) => e.from === 'sw' && e.to === 'si')).toBe(false);
        expect(next.edges.some((e) => e.from === 'sw' && e.to === 'g')).toBe(true);
    });

    it('matches a plain line by its two ends, and leaves an unknown one alone', () => {
        const def = clone(loopy);
        const next = removeConnection(def, { from: 'loop_1', to: 'lim', sourceHandle: 'done', defLabel: null, defCaseName: null });
        expect(next.edges).toEqual([{ from: 'trg', to: 'loop_1' }]);
        expect(removeConnection(def, { from: 'x', to: 'y', sourceHandle: null, defLabel: null, defCaseName: null })).toBe(def);
    });
});
