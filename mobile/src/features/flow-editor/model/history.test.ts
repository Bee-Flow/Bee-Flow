/**
 * The history reducer, through the web hook's own scenarios
 * (agent-hub/src/hooks/useDraftHistory.test.js(x)), with a harness that plays
 * the editor: a draft, and commit / undo / redo driving it. The web hook is
 * React and cannot run here, so its constants are pinned by reading it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CAP, COALESCE_MS, canRedo, canUndo, commitDraft, emptyHistory, redoDraft, sameDraft, undoDraft, type HistoryState } from './history';

type Draft = { v: number } | null;

function harness(initial: Draft) {
    let draft = initial;
    let state: HistoryState<Draft> = emptyHistory();
    let now = 1_000_000;
    return {
        get draft() {
            return draft;
        },
        get state() {
            return state;
        },
        tick(ms = 1000) {
            now += ms;
        },
        commit(next: Draft) {
            const r = commitDraft(state, draft, next, now);
            state = r.state;
            if (r.changed) draft = next;
        },
        undo() {
            const r = undoDraft(state, draft);
            state = r.state;
            if (r.apply !== undefined) draft = r.apply;
        },
        redo() {
            const r = redoDraft(state, draft);
            state = r.state;
            if (r.apply !== undefined) draft = r.apply;
        },
    };
}

describe('the web hook\'s constants', () => {
    it('are 600 ms and 50 entries, as in useDraftHistory.ts', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../../../../../agent-hub/src/hooks/useDraftHistory.ts'), 'utf8');
        expect(src).toContain(`const COALESCE_MS = ${COALESCE_MS};`);
        expect(src).toContain(`const CAP = ${CAP};`);
    });
});

describe('history', () => {
    it('commit applies the next draft and enables undo', () => {
        const h = harness({ v: 0 });
        h.tick();
        h.commit({ v: 1 });
        expect(h.draft).toEqual({ v: 1 });
        expect(canUndo(h.state)).toBe(true);
        expect(canRedo(h.state)).toBe(false);
    });

    it('undo/redo round-trips', () => {
        const h = harness({ v: 0 });
        h.tick();
        h.commit({ v: 1 });
        h.tick();
        h.commit({ v: 2 });
        h.undo();
        expect(h.draft).toEqual({ v: 1 });
        h.undo();
        expect(h.draft).toEqual({ v: 0 });
        h.redo();
        expect(h.draft).toEqual({ v: 1 });
        h.redo();
        expect(h.draft).toEqual({ v: 2 });
        expect(canRedo(h.state)).toBe(false);
        h.redo();
        expect(h.draft).toEqual({ v: 2 });
    });

    it('coalesces rapid commits into one entry holding the pre-burst state', () => {
        const h = harness({ v: 0 });
        h.tick();
        h.commit({ v: 1 });
        h.tick(100);
        h.commit({ v: 2 });
        h.tick(100);
        h.commit({ v: 3 });
        h.tick(1000);
        h.commit({ v: 4 });
        h.undo();
        expect(h.draft).toEqual({ v: 3 });
        h.undo();
        expect(h.draft).toEqual({ v: 0 });
        expect(canUndo(h.state)).toBe(false);
    });

    it('a commit after undo clears the redo stack', () => {
        const h = harness({ v: 0 });
        h.tick();
        h.commit({ v: 1 });
        h.undo();
        h.tick();
        h.commit({ v: 9 });
        expect(canRedo(h.state)).toBe(false);
        expect(h.draft).toEqual({ v: 9 });
    });

    it('an edit right after undo starts a fresh entry', () => {
        const h = harness({ v: 0 });
        h.tick();
        h.commit({ v: 1 });
        h.undo();
        h.tick(50);
        h.commit({ v: 2 });
        h.undo();
        expect(h.draft).toEqual({ v: 0 });
    });

    it('structurally identical commits are no-ops', () => {
        const h = harness({ v: 0 });
        h.tick();
        h.commit({ v: 0 });
        expect(canUndo(h.state)).toBe(false);
        expect(h.state.lastCommitAt).toBe(0);
    });

    it('caps the past at 50 entries; the oldest roll off', () => {
        const h = harness({ v: 0 });
        for (let i = 1; i <= 60; i++) {
            h.tick();
            h.commit({ v: i });
        }
        let undos = 0;
        while (canUndo(h.state) && undos < 100) {
            h.undo();
            undos++;
        }
        expect(undos).toBe(50);
        expect(h.draft).toEqual({ v: 10 });
    });

    it('never makes the pre-first-edit null state undoable', () => {
        const h = harness(null);
        h.commit({ v: 1 });
        expect(canUndo(h.state)).toBe(false);
        h.undo();
        expect(h.draft).toEqual({ v: 1 });
        h.tick();
        h.commit({ v: 2 });
        h.undo();
        expect(h.draft).toEqual({ v: 1 });
    });

    it('snapshots are copies, not the live draft', () => {
        const live = { v: 1 };
        const r = commitDraft(emptyHistory<{ v: number }>(), live, { v: 2 }, 5000);
        live.v = 99;
        expect(r.state.past[0]).toEqual({ v: 1 });
    });

    it('writes each draft’s JSON once, however often it is compared', () => {
        const spy = jest.spyOn(JSON, 'stringify');
        const a = { steps: [{ id: 's1' }] };
        const b = { steps: [{ id: 's1' }] };
        expect(sameDraft(a, b)).toBe(true);
        expect(sameDraft(b, a)).toBe(true);
        expect(sameDraft(a, { steps: [] })).toBe(false);
        expect(spy).toHaveBeenCalledTimes(3);
        spy.mockRestore();
    });

    it('compares drafts structurally, and survives what JSON cannot write', () => {
        expect(sameDraft({ a: [1] }, { a: [1] })).toBe(true);
        expect(sameDraft(null, undefined)).toBe(false);
        expect(sameDraft(null, null)).toBe(true);
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        expect(sameDraft(loop, { self: 1 })).toBe(false);
        const r = commitDraft(emptyHistory<unknown>(), loop, { v: 1 }, 5000);
        expect(r.state.past[0]).toBe(loop);
    });
});
