// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { dwellMs, filmOrder, frameAt, recordsById, serverHead } from './runFilm';

/**
 * The run has to be WATCHABLE: the first steps of a small chain finish inside
 * one poll interval, so the canvas's first frame already had three nodes done
 * and the run never looked like it travelled anywhere (owner, 2026-09-16).
 * The film walks it — without ever showing a node finished before the server
 * says it is.
 */
const DEF = {
    trigger: { id: 'trg', type: 'manual' },
    steps: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }],
};
const rec = (stepId, status) => ({ stepId, status });
const ids = (frame) => frame.map((f) => `${f.stepId}:${f.status}`);

describe('runFilm — the run, one node at a time', () => {
    it('walks the trigger first, then a step per beat', () => {
        const byId = recordsById([rec('s1', 'success'), rec('s2', 'success'), rec('s3', 'running')]);
        const order = filmOrder(DEF);
        expect(order).toEqual(['trg', 's1', 's2', 's3', 's4']);
        // Head 0: the trigger fires and nothing else is on the canvas yet.
        expect(ids(frameAt(order, byId, 0, { hasTrigger: true }))).toEqual(['trg:running']);
        // Head 1: the trigger landed (it has no record of its own), s1 runs.
        expect(ids(frameAt(order, byId, 1, { hasTrigger: true }))).toEqual(['trg:success', 's1:running']);
        expect(ids(frameAt(order, byId, 3, { hasTrigger: true }))).toEqual(['trg:success', 's1:success', 's2:success', 's3:running']);
    });

    it('never runs ahead of the server', () => {
        const order = filmOrder(DEF);
        // Two steps done, the third running: the film may reach s3, no further.
        const byId = recordsById([rec('s1', 'success'), rec('s2', 'success'), rec('s3', 'running')]);
        expect(serverHead(order, byId, { hasTrigger: true })).toBe(3);
        // Nothing recorded at all: the trigger has not even fired.
        expect(serverHead(order, recordsById([]), { hasTrigger: true })).toBe(0);
        // A finished run releases the whole chain — a step that never ran (a
        // branch not taken) must not stall the film on the last node forever.
        expect(serverHead(order, recordsById([rec('s1', 'success')]), { hasTrigger: true, runStatus: 'success' })).toBe(order.length);
    });

    it('a failure is shown as the failure, not as "running"', () => {
        const order = filmOrder(DEF);
        const byId = recordsById([rec('s1', 'success'), rec('s2', 'error')]);
        expect(ids(frameAt(order, byId, 2, { hasTrigger: true }))).toEqual(['trg:success', 's1:success', 's2:error']);
        expect(serverHead(order, byId, { hasTrigger: true })).toBe(3, 'an error is terminal — the run moved on');
    });

    it('sub-steps of a flowlet are not nodes of this canvas', () => {
        const byId = recordsById([rec('s1', 'success'), { stepId: 's9', status: 'success', parentStepId: 's1' }]);
        expect([...byId.keys()]).toEqual(['s1']);
    });

    it('holds a node long enough to be seen, and hurries when the run has run ahead', () => {
        expect(dwellMs(1)).toBeGreaterThanOrEqual(500);
        expect(dwellMs(2)).toBe(dwellMs(1));
        expect(dwellMs(4)).toBeLessThan(dwellMs(1));
        expect(dwellMs(4)).toBeGreaterThan(0);
    });

    it('a definition without a trigger still walks its steps', () => {
        const order = filmOrder({ steps: [{ id: 'a' }, { id: 'b' }] });
        expect(order).toEqual(['a', 'b']);
        expect(ids(frameAt(order, recordsById([rec('a', 'success')]), 1))).toEqual(['a:success', 'b:running']);
    });
});
