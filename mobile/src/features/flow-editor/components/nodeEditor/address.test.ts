/**
 * The node editor opens a step held in a loop's body or a parallel branch by
 * its address: it finds it, writes it where it sits, offers it what its
 * container sees (plus the item and the earlier held steps), and pages through
 * the list that holds it.
 */

import { buildSampleRoot, computeLoopBodyGroups, computeUpstreamGroups, type FlowNode } from '@/features/flow-editor/bindings';
import type { FlowDefinition } from '@/features/flow-editor/model';
import { findNode } from '@/features/flow-editor/model/outline';

import { positionAt, upstreamGroupsAt } from './address';
import { writeStepPatch } from './stepForm';

const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'get', type: 'http_request', label: 'Fetch', method: 'GET', url: 'https://example.test' },
        {
            id: 'lp',
            type: 'loop',
            itemVar: 'row',
            overRef: 'steps.get.output.data',
            body: [
                { id: 'b1', type: 'http_request', label: 'Look up', method: 'GET', url: 'https://example.test/{{loop.row}}' },
                { id: 'b2', type: 'notification', label: 'Ping', body: 'Row {{loop.row}}' },
            ],
        },
        {
            id: 'par',
            type: 'parallel',
            branches: [
                [{ id: 'p1', type: 'wait', seconds: 1 }],
                [
                    { id: 'q1', type: 'http_request', label: 'Left', method: 'GET', url: 'https://example.test/q' },
                    { id: 'q2', type: 'notification', body: 'done' },
                ],
            ],
        },
    ],
    edges: [
        { from: 'trg', to: 'get' },
        { from: 'get', to: 'lp' },
        { from: 'lp', to: 'par' },
    ],
} as unknown as FlowDefinition;

const loop = DEF.steps[1] as unknown as FlowNode;

describe('findNode / writeStepPatch at an address', () => {
    it('finds a held step, and nothing for an address that leads nowhere', () => {
        expect(findNode(DEF, 'lp/b2')?.label).toBe('Ping');
        expect(findNode(DEF, 'par/q1')?.label).toBe('Left');
        expect(findNode(DEF, 'lp/q1')).toBeNull();
        expect(findNode(DEF, 'b2')).toBeNull();
    });

    it('merges a patch into the held step where it sits, and leaves the edges alone', () => {
        const next = writeStepPatch(DEF, 'lp/b2', { body: 'Row {{loop.row}} done' });
        expect(findNode(next, 'lp/b2')).toMatchObject({ id: 'b2', label: 'Ping', body: 'Row {{loop.row}} done' });
        expect(next.edges).toBe(DEF.edges);
        expect(findNode(DEF, 'lp/b2')?.body).toBe('Row {{loop.row}}');
        expect(writeStepPatch(DEF, 'par/q2', { seconds: 3, id: 'hijack' }).steps[2]).toMatchObject({
            branches: [[{ id: 'p1' }], [{ id: 'q1' }, { id: 'q2', seconds: 3 }]],
        });
    });

    it('changes nothing for an empty patch or an unknown address', () => {
        expect(writeStepPatch(DEF, 'lp/b2', {})).toBe(DEF);
        expect(writeStepPatch(DEF, 'lp/zz', { body: 'x' })).toBe(DEF);
    });
});

describe('upstreamGroupsAt', () => {
    it('is the flow’s upstream walk for a top-level step', () => {
        expect(upstreamGroupsAt(DEF, 'lp', null)).toEqual(computeUpstreamGroups(DEF, 'lp', null));
    });

    it('gives a body step what its loop sees, the current item and the earlier body steps', () => {
        const outer = computeUpstreamGroups(DEF, 'lp', null);
        const groups = upstreamGroupsAt(DEF, 'lp/b2', null);
        expect(groups).toEqual(
            computeLoopBodyGroups(loop, 1, { outerGroups: outer, previewSample: buildSampleRoot(outer), catalog: null, definition: DEF }),
        );
        expect(groups.map((g) => g.id)).toEqual([...outer.map((g) => g.id), '__loop_item', 'b1']);
    });

    it('gives a branch step what its parallel step sees and the branch’s earlier steps', () => {
        const outer = computeUpstreamGroups(DEF, 'par', null);
        expect(upstreamGroupsAt(DEF, 'par/q2', null).map((g) => g.id)).toEqual([...outer.map((g) => g.id), 'q1']);
        expect(upstreamGroupsAt(DEF, 'par/q1', null)).toEqual(outer);
        expect(upstreamGroupsAt(DEF, 'par/nope', null)).toEqual([]);
    });
});

describe('positionAt', () => {
    it('pages through the list that holds a step', () => {
        expect(positionAt(DEF, 'lp/b1')).toEqual({ index: 1, total: 2, prevId: null, nextId: 'lp/b2' });
        expect(positionAt(DEF, 'par/q2')).toEqual({ index: 2, total: 2, prevId: 'par/q1', nextId: null });
        expect(positionAt(DEF, 'par/p1')).toEqual({ index: 1, total: 1, prevId: null, nextId: null });
        expect(positionAt(DEF, 'lp/zz')).toEqual({ index: 0, total: 0, prevId: null, nextId: null });
    });

    it('is the run order for a top-level step', () => {
        expect(positionAt(DEF, 'lp')).toMatchObject({ prevId: 'get', nextId: 'par' });
    });
});
