import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { MIN_MOVE_GAP_MS, WRAP_HOLD_MS, ROW_PITCH, COL_PITCH, REVEAL_STAGGER_MS } from './buildChoreography';
import { useBuildChoreography, FLAG_TTL_MS, GHOST_ID } from './useBuildChoreography';

// React Flow's fit-on-mount fires onMoveStart with a null event a frame or two
// after the canvas mounts, so the hook owns the camera for a grace period after
// mounting with a trigger; a test that plays the USER has to wait it out.
const MOUNT_GRACE_MS = 1500;

/**
 * The stateful half of the build film, driven through renderHook with a fake
 * React Flow and fake timers (including requestAnimationFrame — the reduced-
 * motion path schedules through it).
 *
 * The camera assertions are about WHICH call and WHEN: one push-in per
 * off-screen arrival, none for a card already in view, never two moves inside
 * the 1200 ms hold, wide-then-push on a row wrap, and — the owner's rule —
 * nothing at all once the presenter has taken the viewport until Follow is
 * pressed. The flag assertions pin that fresh/touched/frontier/ghost derive
 * from the DIFF of drafts, arrive on the same render as the new card, and die
 * by time or when the build ends.
 */

const TRIGGER = { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start' };

/** A chain of `n` steps after the trigger, one column pitch apart, wrapping at column 5 like rowLayoutPositions. */
function chain(n, extra = {}) {
    const steps = [];
    const edges = [];
    let prev = 'trg';
    for (let i = 1; i <= n; i += 1) {
        const id = `s${i}`;
        steps.push({ id, type: 'set', label: `Step ${i}`, fields: [{ name: 'a', value: String(i) }] });
        edges.push({ from: prev, to: id });
        prev = id;
    }
    return { trigger: TRIGGER, steps, edges, ...extra };
}

/** Layout the way arrange.js lays a chain out: five columns, then the next row. */
function nodesOf(def) {
    const all = [def.trigger, ...(def.steps || [])].filter(Boolean);
    return all.map((s, i) => ({
        id: s.id,
        type: s.type,
        position: { x: (i % 5) * COL_PITCH, y: Math.floor(i / 5) * ROW_PITCH },
    }));
}

function edgesOf(def) {
    return (def.edges || []).map(e => ({ id: `${e.from}->${e.to}||`, source: e.from, target: e.to }));
}

function makeRf(viewport = { x: 0, y: 0, zoom: 1 }) {
    return {
        fitView: vi.fn(),
        setViewport: vi.fn(),
        setCenter: vi.fn(),
        getViewport: vi.fn(() => viewport),
    };
}

const wrapperRef = { current: { getBoundingClientRect: () => ({ width: 1100, height: 750, left: 0, top: 0 }) } };

const cue = (over = {}) => ({ running: true, phase: 'building', startedAt: 0, lastCall: null, narration: null, todos: [], finalizedId: null, aborted: null, stepCount: 0, ...over });

function propsFor(def, over = {}) {
    return {
        definition: def,
        computedNodes: nodesOf(def),
        edges: edgesOf(def),
        structuralEditsBlocked: true,
        buildCue: cue(),
        rf: makeRf(),
        wrapperRef,
        reducedMotion: false,
        runInFlight: false,
        ...over,
    };
}

function mount(initial) {
    return renderHook((p) => useBuildChoreography(p), { initialProps: initial });
}

const cameraCalls = (rf) => rf.fitView.mock.calls.length + rf.setViewport.mock.calls.length + rf.setCenter.mock.calls.length;

// The hook stamps `Date.now()` on flags and moves, so the clock has to be
// faked alongside the timers; rAF is included for the reduced-motion path.
const FAKES = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'];

describe('useBuildChoreography — flags', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: FAKES }); vi.setSystemTime(100000); });
    afterEach(() => { vi.useRealTimers(); });

    it('an arrival is flagged fresh (delay 0) on the render it appears, with its edge and the frontier', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        expect(result.current.buildFxById.size).toBe(0);
        expect(result.current.frontierId).toBeNull();

        rerender(propsFor(chain(2), { rf }));
        const fx = result.current.buildFxById.get('s2');
        expect(fx).toMatchObject({ kind: 'fresh', delayMs: 0 });
        expect(typeof fx.at).toBe('number');
        expect(result.current.frontierId).toBe('s2');
        expect([...result.current.freshEdgeKeys]).toEqual(['s1->s2||']);
        // The cards that were already there are untouched.
        expect(result.current.buildFxById.has('s1')).toBe(false);
    });

    it('a burst is dealt one card per 1.2 s, in run order; the frontier starts on the head and walks the queue', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(7), { rf }));
        const delays = ['s2', 's3', 's4', 's5', 's6', 's7'].map(id => result.current.buildFxById.get(id).delayMs);
        expect(delays).toEqual([0, 1200, 2400, 3600, 4800, 6000]);
        // Every card is flagged on the render it appears (its reveal is a CSS
        // delay), but the frontier is on the HEAD, and the rest are queued.
        expect(result.current.frontierId).toBe('s2');
        expect(result.current.revealQueue.map(p => p.id)).toEqual(['s3', 's4', 's5', 's6', 's7']);
        expect(result.current.revealQueue.map(p => p.at - 100000)).toEqual([1200, 2400, 3600, 4800, 6000]);
        expect(result.current.revealHead).toEqual({ id: 's2', at: 100000 });
        act(() => { vi.advanceTimersByTime(1200); });
        expect(result.current.frontierId).toBe('s3');
        expect(result.current.revealQueue.map(p => p.id)).toEqual(['s4', 's5', 's6', 's7']);
        // One act per beat: a timer's state commits at the end of its act, and
        // the next beat's timer is armed from that commit.
        for (const expected of ['s4', 's5', 's6', 's7']) {
            act(() => { vi.advanceTimersByTime(1200); });
            expect(result.current.frontierId).toBe(expected);
        }
        expect(result.current.revealQueue).toEqual([]);
    });

    it('the ghost slot hops ahead of the card that is landing, not past the whole burst', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(4), { rf })); // s2 (col 2), s3 (col 3), s4 (col 4)
        expect(result.current.ghostNodes[0].position).toEqual({ x: 3 * COL_PITCH, y: 0 });
        act(() => { vi.advanceTimersByTime(1200); });
        expect(result.current.ghostNodes[0].position).toEqual({ x: 4 * COL_PITCH, y: 0 });
        act(() => { vi.advanceTimersByTime(1200); });
        // s4 sits in the last column: the slot wraps to the next row.
        expect(result.current.ghostNodes[0].position).toEqual({ x: 0, y: ROW_PITCH });
    });

    it('orderHint deals the burst in the model\'s order, not flowOrder', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(4), { rf, orderHint: ['s4', 's2', 's3'] }));
        expect(result.current.buildFxById.get('s4').delayMs).toBe(0);
        expect(result.current.buildFxById.get('s2').delayMs).toBe(1200);
        expect(result.current.buildFxById.get('s3').delayMs).toBe(2400);
        expect(result.current.frontierId).toBe('s4');
        expect(result.current.revealQueue.map(p => p.id)).toEqual(['s2', 's3']);
        // A hint that names a card the diff did not add is ignored; one that
        // forgets a card still deals it, last.
        const { result: r2, rerender: rr2 } = mount(propsFor(chain(1), { rf: makeRf() }));
        rr2(propsFor(chain(3), { rf: makeRf(), orderHint: ['nope', 's3'] }));
        expect(r2.current.frontierId).toBe('s3');
        expect(r2.current.revealQueue.map(p => p.id)).toEqual(['s2']);
    });

    it('flightMs is added to every card\'s delay and its edge\'s expiry, but not to its departure', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf, flightMs: 600 }));
        rerender(propsFor(chain(3), { rf, flightMs: 600 }));
        expect(result.current.buildFxById.get('s2').delayMs).toBe(600);
        expect(result.current.buildFxById.get('s3').delayMs).toBe(1800);
        expect(result.current.revealHead).toEqual({ id: 's2', at: 100000 });
        expect(result.current.revealQueue).toEqual([{ id: 's3', at: 101200 }]);
        // s2's flag and edge live FLAG_TTL + 600; s3's FLAG_TTL + 1800.
        act(() => { vi.advanceTimersByTime(FLAG_TTL_MS + 600 - 1); });
        expect(result.current.buildFxById.has('s2')).toBe(true);
        expect(result.current.freshEdgeKeys.has('s1->s2||')).toBe(true);
        act(() => { vi.advanceTimersByTime(2); });
        expect(result.current.buildFxById.has('s2')).toBe(false);
        expect(result.current.freshEdgeKeys.has('s1->s2||')).toBe(false);
        expect(result.current.freshEdgeKeys.has('s2->s3||')).toBe(true);
        act(() => { vi.advanceTimersByTime(1200); });
        expect(result.current.buildFxById.has('s3')).toBe(false);
        expect(result.current.freshEdgeKeys.size).toBe(0);
    });

    it('an abort mid-burst (blocked → false) empties the queue and cues no later landing', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(4), { rf }));
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1); // the head's push
        rerender(propsFor(chain(4), { rf, structuralEditsBlocked: false }));
        expect(result.current.revealQueue).toEqual([]);
        expect(result.current.revealHead).toBeNull();
        expect(result.current.frontierId).toBeNull();
        const closing = rf.fitView.mock.calls.length; // the closing wide shot, once
        act(() => { vi.advanceTimersByTime(10000); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1);
        expect(rf.fitView).toHaveBeenCalledTimes(closing);
    });

    it('a StrictMode-style double mount deals the queue once and leaks no timer', () => {
        const rf = makeRf();
        const wrapper = ({ children }) => <React.StrictMode>{children}</React.StrictMode>;
        const { result, rerender, unmount } = renderHook((p) => useBuildChoreography(p), { initialProps: propsFor(chain(1), { rf }), wrapper });
        rerender(propsFor(chain(4), { rf }));
        expect(result.current.frontierId).toBe('s2');
        act(() => { vi.advanceTimersByTime(1200); });
        expect(result.current.frontierId).toBe('s3');
        act(() => { vi.advanceTimersByTime(1200); });
        expect(result.current.frontierId).toBe('s4');
        expect(result.current.revealQueue).toEqual([]);
        const moves = cameraCalls(rf);
        unmount();
        expect(vi.getTimerCount()).toBe(0);
        act(() => { vi.advanceTimersByTime(10000); });
        expect(cameraCalls(rf)).toBe(moves);
    });

    it('an edit flags the card touched with a touchedAt, and moves the frontier only when it is the last card', () => {
        const rf = makeRf();
        const three = chain(3);
        const { result, rerender } = mount(propsFor(three, { rf }));
        const edited = { ...three, steps: three.steps.map(s => (s.id === 's2' ? { ...s, label: 'Renamed' } : s)) };
        rerender(propsFor(edited, { rf }));
        expect(result.current.buildFxById.get('s2')).toMatchObject({ kind: 'touched', delayMs: 0 });
        expect(typeof result.current.buildFxById.get('s2').touchedAt).toBe('number');
        expect(result.current.frontierId).toBeNull();

        const last = { ...edited, steps: edited.steps.map(s => (s.id === 's3' ? { ...s, label: 'Last' } : s)) };
        rerender(propsFor(last, { rf }));
        expect(result.current.frontierId).toBe('s3');
    });

    it('a position-only change and a refused call (identical draft) flag nothing', () => {
        const rf = makeRf();
        const def = chain(2);
        const { result, rerender } = mount(propsFor(def, { rf }));
        rerender(propsFor(JSON.parse(JSON.stringify(def)), { rf }));
        expect(result.current.buildFxById.size).toBe(0);
        const moved = { ...def, steps: def.steps.map(s => ({ ...s, position: { x: 999, y: 1 } })) };
        rerender(propsFor(moved, { rf }));
        expect(result.current.buildFxById.size).toBe(0);
        expect(cameraCalls(rf)).toBe(0);
    });

    it('flags are pruned after 1400 ms (+ the card\'s delay); the frontier stays', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(3), { rf }));
        expect(result.current.buildFxById.size).toBe(2);
        act(() => { vi.advanceTimersByTime(FLAG_TTL_MS - 1); });
        expect(result.current.buildFxById.has('s2')).toBe(true);
        act(() => { vi.advanceTimersByTime(2); });
        expect(result.current.buildFxById.has('s2')).toBe(false);
        // A two-card burst is dealt a beat (1200 ms) apart: s3 revealed 1200 ms
        // later, so it lives 1200 ms longer — and so does its edge.
        expect(result.current.buildFxById.get('s3').delayMs).toBe(REVEAL_STAGGER_MS);
        expect(result.current.freshEdgeKeys.has('s2->s3||')).toBe(true);
        act(() => { vi.advanceTimersByTime(REVEAL_STAGGER_MS - 2); });
        expect(result.current.buildFxById.has('s3')).toBe(true);
        act(() => { vi.advanceTimersByTime(2); });
        expect(result.current.buildFxById.size).toBe(0);
        expect(result.current.freshEdgeKeys.size).toBe(0);
        expect(result.current.frontierId).toBe('s3');
    });

    it('blocked → false clears everything synchronously', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(2), { rf }));
        expect(result.current.ghostNodes.length).toBe(1);
        rerender(propsFor(chain(2), { rf, structuralEditsBlocked: false }));
        expect(result.current.buildFxById.size).toBe(0);
        expect(result.current.frontierId).toBeNull();
        expect(result.current.freshEdgeKeys.size).toBe(0);
        expect(result.current.ghostNodes).toEqual([]);
        expect(result.current.ghostEdges).toEqual([]);
    });

    it('phase "testing" clears the frontier (and the flags and ghost with it)', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(2), { rf }));
        expect(result.current.frontierId).toBe('s2');
        rerender(propsFor(chain(2), { rf, buildCue: cue({ phase: 'testing' }) }));
        expect(result.current.frontierId).toBeNull();
        expect(result.current.buildFxById.size).toBe(0);
        expect(result.current.ghostNodes).toEqual([]);
    });

    it('a run in flight mid-build hands the canvas to the run vocabulary', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(2), { rf }));
        rerender(propsFor(chain(2), { rf, runInFlight: true }));
        expect(result.current.frontierId).toBeNull();
        expect(result.current.ghostNodes).toEqual([]);
    });

    it('does nothing while the canvas is the user\'s (not blocked)', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf, structuralEditsBlocked: false }));
        rerender(propsFor(chain(2), { rf, structuralEditsBlocked: false }));
        expect(result.current.buildFxById.size).toBe(0);
        expect(result.current.ghostNodes).toEqual([]);
        expect(cameraCalls(rf)).toBe(0);
    });
});

describe('useBuildChoreography — the ghost slot', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: FAKES }); vi.setSystemTime(100000); });
    afterEach(() => { vi.useRealTimers(); });

    it('stands one column ahead of the frontier after an addition, tethered to it', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(2), { rf }));
        const [ghost] = result.current.ghostNodes;
        expect(ghost).toMatchObject({
            id: GHOST_ID, type: 'ghost_step', position: { x: 3 * COL_PITCH, y: 0 },
            draggable: false, selectable: false, connectable: false, focusable: false, deletable: false, zIndex: -1,
        });
        expect(ghost.data).toEqual({ caption: null, synthetic: true, draft: null });
        expect(result.current.ghostEdges[0]).toMatchObject({ source: 's2', target: GHOST_ID, type: 'toolLink', selectable: false, focusable: false });
    });

    it('is on screen before anything was added, after the last card in run order', () => {
        const rf = makeRf();
        const { result } = mount(propsFor(chain(1), { rf }));
        expect(result.current.ghostNodes[0].position).toEqual({ x: 2 * COL_PITCH, y: 0 });
        expect(result.current.ghostEdges[0].source).toBe('s1');
    });

    it('wraps to the first column of the next row when the frontier sits in column 5', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(3), { rf }));
        rerender(propsFor(chain(4), { rf })); // s4 is the 5th card → column 5
        expect(result.current.ghostNodes[0].position).toEqual({ x: 0, y: ROW_PITCH });
    });

    it('hides after a removal until the next addition', () => {
        const rf = makeRf();
        const three = chain(3);
        const { result, rerender } = mount(propsFor(three, { rf }));
        expect(result.current.ghostNodes.length).toBe(1);
        const removed = { ...three, steps: three.steps.filter(s => s.id !== 's3'), edges: three.edges.filter(e => e.to !== 's3') };
        rerender(propsFor(removed, { rf }));
        expect(result.current.ghostNodes).toEqual([]);
        // An edit does not bring it back…
        const edited = { ...removed, steps: removed.steps.map(s => (s.id === 's2' ? { ...s, label: 'x' } : s)) };
        rerender(propsFor(edited, { rf }));
        expect(result.current.ghostNodes).toEqual([]);
        // …an addition does.
        rerender(propsFor(chain(3), { rf }));
        expect(result.current.ghostNodes.length).toBe(1);
    });

    it('caption: the narrated thought beats the first open todo, which beats nothing', () => {
        const rf = makeRf();
        const todos = [{ text: 'Pick a trigger', done: true }, { text: 'Wire the error branch', done: false }];
        const { result, rerender } = mount(propsFor(chain(1), { rf, buildCue: cue({ todos }) }));
        expect(result.current.ghostNodes[0].data.caption).toBe('Wire the error branch');
        rerender(propsFor(chain(1), { rf, buildCue: cue({ todos, narration: '  Choosing the schedule ' }) }));
        expect(result.current.ghostNodes[0].data.caption).toBe('Choosing the schedule');
        rerender(propsFor(chain(1), { rf, buildCue: cue({ todos: [], narration: '' }) }));
        expect(result.current.ghostNodes[0].data.caption).toBeNull();
    });

    it('carries the card being drawn when the cue has a toolDraft, and null otherwise', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        expect(result.current.ghostNodes[0].data.draft).toBeNull();
        expect(result.current.ghostDraft).toBeNull();
        const toolDraft = {
            name: 'builder_add_steps', chars: 120, count: 2, inspect: [], at: 100000,
            steps: [
                { type: 'set', tool: null, label: 'Edit data', partial: false },
                { type: 'integration_action', tool: 'gmail_send', label: 'Send the sum', partial: true },
            ],
        };
        rerender(propsFor(chain(1), { rf, buildCue: cue({ toolDraft }) }));
        const { draft } = result.current.ghostNodes[0].data;
        expect(draft).toMatchObject({
            kind: 'step', type: 'integration_action', tool: 'gmail_send', label: 'Send the sum', partial: true,
            index: 2, count: 2, stepOf: 'Step 2 of 2', caption: 'Send the sum',
            app: { id: 'gmail', name: 'Gmail' },
        });
        expect(result.current.ghostDraft).toBe(draft);
        // The caption from narration/todos is kept alongside — the node decides what to show.
        expect(result.current.ghostNodes[0].data.caption).toBeNull();
        // The draft clears with the tool call landing (the hook clears state.toolDraft).
        rerender(propsFor(chain(1), { rf, buildCue: cue({ toolDraft: null }) }));
        expect(result.current.ghostNodes[0].data.draft).toBeNull();
    });

    it('a toolDraft is ignored while the film is not playing (not blocked, a run in flight)', () => {
        const rf = makeRf();
        const toolDraft = { name: 'builder_set_plan', steps: [], count: 0, inspect: [], chars: 5, at: 100000 };
        const { result, rerender } = mount(propsFor(chain(1), { rf, structuralEditsBlocked: false, buildCue: cue({ toolDraft }) }));
        expect(result.current.ghostNodes).toEqual([]);
        expect(result.current.ghostDraft).toBeNull();
        rerender(propsFor(chain(1), { rf, runInFlight: true, buildCue: cue({ toolDraft }) }));
        expect(result.current.ghostDraft).toBeNull();
    });

    it('a step being typed brings the slot back after a removal — the promise renewed', () => {
        const rf = makeRf();
        const three = chain(3);
        const { result, rerender } = mount(propsFor(three, { rf }));
        const removed = { ...three, steps: three.steps.filter(s => s.id !== 's3'), edges: three.edges.filter(e => e.to !== 's3') };
        rerender(propsFor(removed, { rf }));
        expect(result.current.ghostNodes).toEqual([]);
        // An activity does not (nothing is going to land)…
        rerender(propsFor(removed, { rf, buildCue: cue({ toolDraft: { name: 'builder_set_plan', steps: [], count: 0, inspect: [], chars: 3, at: 100000 } }) }));
        expect(result.current.ghostNodes).toEqual([]);
        // …a card being typed does, one column past the last card in flow.
        const typing = { name: 'builder_add_action', steps: [{ type: 'integration_action', tool: 'gmail_send', label: null, partial: true }], count: 1, inspect: [], chars: 40, at: 100000 };
        rerender(propsFor(removed, { rf, buildCue: cue({ toolDraft: typing }) }));
        expect(result.current.ghostNodes).toHaveLength(1);
        expect(result.current.ghostNodes[0].position).toEqual({ x: 3 * COL_PITCH, y: 0 });
        expect(result.current.ghostNodes[0].data.draft).toMatchObject({ kind: 'step', caption: 'Placing Gmail…', stepOf: null });
    });
});

describe('useBuildChoreography — the camera', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: FAKES }); vi.setSystemTime(100000); });
    afterEach(() => { vi.useRealTimers(); });

    /**
     * Advance to a queued departure, then one more tick. Under act() a timer
     * that sets state commits at the END of the act, so the camera plan the
     * landing cues (a 0 ms timer once the hold has elapsed) is armed after the
     * clock has already moved and needs a tick of its own to fire. In the
     * browser the two are a microtask apart.
     */
    const dealNext = (ms) => {
        act(() => { vi.advanceTimersByTime(ms); });
        act(() => { vi.advanceTimersByTime(1); });
    };

    it('one arrival off-screen → one push-in via setViewport at near zoom, biased toward the new card', () => {
        const rf = makeRf();
        const { rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(2), { rf }));
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1);
        expect(rf.fitView).not.toHaveBeenCalled();
        const [vp, opts] = rf.setViewport.mock.calls[0];
        // Predecessor + new card + ghost = 880 px → zoom 1.0 (near LOD).
        expect(vp.zoom).toBe(1);
        expect(opts.duration).toBe(480);
        expect(['linear', 'smooth']).toContain(opts.interpolate);
        // The new card (x 640..880) ends up on screen with margin.
        expect(640 * vp.zoom + vp.x).toBeGreaterThanOrEqual(48);
        expect(880 * vp.zoom + vp.x).toBeLessThanOrEqual(1100 - 48);
    });

    it('the canvas changing size re-frames once it settles — and the first measurement is not a resize', () => {
        const observers = [];
        const real = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
            constructor(cb) { this.cb = cb; observers.push(this); }
            observe() { }
            disconnect() { }
            emit(width, height) { this.cb([{ contentRect: { width, height } }]); }
        };
        try {
            const rf = makeRf();
            mount(propsFor(chain(2), { rf }));
            act(() => { vi.advanceTimersByTime(2000); });
            const before = cameraCalls(rf);
            // The observer's first callback is the measurement, not a change.
            act(() => { observers.at(-1).emit(1100, 750); });
            act(() => { vi.advanceTimersByTime(400); });
            expect(cameraCalls(rf)).toBe(before);
            // A real resize re-frames once, after it settles.
            act(() => { observers.at(-1).emit(700, 750); });
            act(() => { vi.advanceTimersByTime(100); });
            expect(cameraCalls(rf)).toBe(before);
            act(() => { vi.advanceTimersByTime(200); });
            expect(cameraCalls(rf)).toBe(before + 1);
            // A drag of a splitter is many callbacks and still one shot.
            act(() => { observers.at(-1).emit(690, 750); observers.at(-1).emit(600, 750); observers.at(-1).emit(520, 750); });
            act(() => { vi.advanceTimersByTime(400); });
            expect(cameraCalls(rf)).toBe(before + 2);
        } finally {
            globalThis.ResizeObserver = real;
        }
    });

    it('a strip of canvas covered by the plan panel is framed around, not into', () => {
        // The same arrival as the push test, with 264 px of the left edge
        // covered: the frame lands in the 836 px that are left.
        const rf = makeRf();
        const { rerender } = mount(propsFor(chain(1), { rf, cameraInsetLeft: 264 }));
        rerender(propsFor(chain(2), { rf, cameraInsetLeft: 264 }));
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1);
        const [vp] = rf.setViewport.mock.calls[0];
        // The predecessor — the leftmost card of the shot — clears the panel.
        expect(320 * vp.zoom + vp.x).toBeGreaterThanOrEqual(264);
        expect(880 * vp.zoom + vp.x).toBeLessThanOrEqual(1100 - 48);
    });

    it('a card behind the panel is not "in view": it earns a push', () => {
        // Viewport that puts the new card (640..880) at 100..340 — clear of the
        // canvas edge, but under a 264 px panel.
        const rf = makeRf({ x: -540, y: 300, zoom: 1 });
        const { rerender } = mount(propsFor(chain(1), { rf, cameraInsetLeft: 264 }));
        rerender(propsFor(chain(2), { rf, cameraInsetLeft: 264 }));
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1);
        // Without the panel the very same frame is left alone.
        const bare = makeRf({ x: -540, y: 300, zoom: 1 });
        const second = mount(propsFor(chain(1), { rf: bare }));
        second.rerender(propsFor(chain(2), { rf: bare }));
        act(() => { vi.advanceTimersByTime(2000); });
        expect(cameraCalls(bare)).toBe(0);
    });

    it('the panel arriving re-frames; it does not on the value a build starts with', () => {
        const rf = makeRf();
        const { rerender } = mount(propsFor(chain(2), { rf, cameraInsetLeft: 264 }));
        act(() => { vi.advanceTimersByTime(2000); });
        const before = cameraCalls(rf);
        rerender(propsFor(chain(2), { rf, cameraInsetLeft: 0 }));
        act(() => { vi.advanceTimersByTime(400); });
        expect(cameraCalls(rf)).toBe(before + 1);
    });

    it('an arrival already in view moves nothing', () => {
        // Viewport shifted so the new card (640..880, 0..96) sits well inside.
        const rf = makeRf({ x: -300, y: 300, zoom: 1 });
        const { rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(2), { rf }));
        act(() => { vi.advanceTimersByTime(2000); });
        expect(cameraCalls(rf)).toBe(0);
    });

    it('two arrivals 400 ms apart → the second waits for the 1200 ms hold', () => {
        const rf = makeRf();
        const { rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(2), { rf }));
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1);
        act(() => { vi.advanceTimersByTime(399); });
        rerender(propsFor(chain(3), { rf }));
        act(() => { vi.advanceTimersByTime(MIN_MOVE_GAP_MS - 400 - 10); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1);
        act(() => { vi.advanceTimersByTime(20); });
        expect(rf.setViewport).toHaveBeenCalledTimes(2);
    });

    it('a row wrap → wide (fitView) first, then the push-in 900 ms later', () => {
        const rf = makeRf();
        const { rerender } = mount(propsFor(chain(4), { rf })); // s4 in column 5
        rerender(propsFor(chain(5), { rf })); // s5 opens row 2
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.fitView).toHaveBeenCalledTimes(1);
        expect(rf.fitView.mock.calls[0][0]).toMatchObject({ padding: 0.12, minZoom: 0.2, maxZoom: 1, duration: 700, interpolate: 'smooth' });
        expect(rf.setViewport).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(WRAP_HOLD_MS - 10); });
        expect(rf.setViewport).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(20); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1);
    });

    it('a burst is dealt card by card: a push per landing that is off-screen, and one wide shot after the last', () => {
        const rf = makeRf();
        const { rerender } = mount(propsFor(chain(1), { rf }));
        // s2, s3, s4 — three cards on row 0, whose top edge sits inside the
        // 48 px margin at this viewport, so each landing is off-screen.
        rerender(propsFor(chain(4), { rf }));
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1); // the head, at once
        expect(rf.fitView).not.toHaveBeenCalled();
        dealNext(REVEAL_STAGGER_MS - 1); // s3 departs at 1200; the hold since the head's push has just elapsed
        expect(rf.setViewport).toHaveBeenCalledTimes(2);
        expect(rf.fitView).not.toHaveBeenCalled();
        dealNext(REVEAL_STAGGER_MS - 1); // s4 at 2400, the last of three: the wide shot, not a push
        expect(rf.setViewport).toHaveBeenCalledTimes(2);
        expect(rf.fitView).toHaveBeenCalledTimes(1);
        expect(rf.fitView.mock.calls[0][0]).toMatchObject({ padding: 0.12, minZoom: 0.2, maxZoom: 1, duration: 700 });
        act(() => { vi.advanceTimersByTime(5000); });
        expect(rf.fitView).toHaveBeenCalledTimes(1);
        expect(rf.setViewport).toHaveBeenCalledTimes(2);
    });

    it('two cards are a pair, not a chapter: two pushes and no wide shot', () => {
        const rf = makeRf();
        const { rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(3), { rf }));
        act(() => { vi.advanceTimersByTime(1); });
        dealNext(REVEAL_STAGGER_MS - 1);
        act(() => { vi.advanceTimersByTime(5000); });
        expect(rf.setViewport).toHaveBeenCalledTimes(2);
        expect(rf.fitView).not.toHaveBeenCalled();
    });

    it('a row wrap inside a burst → wide, then push, at the card that opens the row; the wide after the last still comes', () => {
        const rf = makeRf();
        const { rerender } = mount(propsFor(chain(1), { rf }));
        // s2..s6: s5 is the sixth card and opens row 2; s6 follows it there.
        rerender(propsFor(chain(6), { rf }));
        act(() => { vi.advanceTimersByTime(1); }); // s2, the head
        dealNext(REVEAL_STAGGER_MS - 1); // s3 at 1200
        dealNext(REVEAL_STAGGER_MS - 1); // s4 at 2400
        expect(rf.setViewport).toHaveBeenCalledTimes(3);
        expect(rf.fitView).not.toHaveBeenCalled();
        dealNext(REVEAL_STAGGER_MS - 1); // s5 at 3600 opens row 2: the wrap's wide first
        expect(rf.fitView).toHaveBeenCalledTimes(1);
        expect(rf.setViewport).toHaveBeenCalledTimes(3);
        act(() => { vi.advanceTimersByTime(WRAP_HOLD_MS); }); // …then the push onto the new row
        expect(rf.setViewport).toHaveBeenCalledTimes(4);
        // s6 at 4800, the last: the burst's closing wide, MIN_MOVE_GAP_MS after that push.
        act(() => { vi.advanceTimersByTime(REVEAL_STAGGER_MS - WRAP_HOLD_MS); });
        act(() => { vi.advanceTimersByTime(MIN_MOVE_GAP_MS); });
        expect(rf.fitView).toHaveBeenCalledTimes(2);
        expect(rf.setViewport).toHaveBeenCalledTimes(4);
        act(() => { vi.advanceTimersByTime(5000); });
        expect(rf.fitView).toHaveBeenCalledTimes(2);
        expect(rf.setViewport).toHaveBeenCalledTimes(4);
    });

    it('a touched card off-screen → setCenter at the current zoom; on-screen → nothing', () => {
        const rf = makeRf({ x: 0, y: 0, zoom: 0.7 });
        const three = chain(3);
        const { rerender } = mount(propsFor(three, { rf }));
        // s3 is the fourth card, at (960, 0): top edge at 0 < 48 → off-screen.
        const edited = { ...three, steps: three.steps.map(s => (s.id === 's3' ? { ...s, label: 'Edited' } : s)) };
        rerender(propsFor(edited, { rf }));
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.setCenter).toHaveBeenCalledTimes(1);
        const [cx, cy, opts] = rf.setCenter.mock.calls[0];
        expect([cx, cy]).toEqual([960 + 120, 48]);
        expect(opts).toEqual({ duration: 300, zoom: 0.7 });

        const inView = makeRf({ x: -300, y: 300, zoom: 1 });
        const { rerender: rerender2 } = mount(propsFor(three, { rf: inView }));
        rerender2(propsFor(edited, { rf: inView }));
        act(() => { vi.advanceTimersByTime(2000); });
        expect(cameraCalls(inView)).toBe(0);
    });

    it('onMoveStart while not camera-owned yields for good: nothing moves until resumeFollow()', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        expect(result.current.following).toBe(true);
        act(() => { vi.advanceTimersByTime(MOUNT_GRACE_MS + 100); });
        act(() => { result.current.onMoveStart(new Event('wheel'), { x: 0, y: 0, zoom: 1 }); });
        expect(result.current.following).toBe(false);

        rerender(propsFor(chain(2), { rf }));
        rerender(propsFor(chain(5), { rf }));
        // Long enough for every queued landing to be dealt (s5 departs at
        // 2400; one act per hop, since a timer's state commits at the act's end)…
        act(() => { vi.advanceTimersByTime(1200); });
        act(() => { vi.advanceTimersByTime(1200); });
        act(() => { vi.advanceTimersByTime(600); });
        expect(cameraCalls(rf)).toBe(0);
        // …and the cards keep arriving and animating where they land.
        expect(result.current.buildFxById.get('s5')).toMatchObject({ kind: 'fresh' });
        expect(result.current.frontierId).toBe('s5');

        act(() => { result.current.resumeFollow(); });
        expect(result.current.following).toBe(true);
        expect(rf.fitView).toHaveBeenCalledTimes(1);
    });

    it('a null-event move counts as the user too (zoom stack, minimap)', () => {
        const rf = makeRf();
        const { result } = mount(propsFor(chain(1), { rf }));
        act(() => { vi.advanceTimersByTime(MOUNT_GRACE_MS + 100); });
        act(() => { result.current.onMoveStart(null, { x: 0, y: 0, zoom: 1 }); });
        expect(result.current.following).toBe(false);
    });

    it('but not inside the mount grace — that is React Flow fitting the canvas it just mounted', () => {
        const rf = makeRf();
        const { result } = mount(propsFor(chain(1), { rf }));
        act(() => { vi.advanceTimersByTime(MOUNT_GRACE_MS - 100); });
        act(() => { result.current.onMoveStart(null, { x: 0, y: 0, zoom: 1 }); });
        expect(result.current.following).toBe(true);
    });

    it('onMoveStart during our own move is ignored', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf }));
        act(() => { vi.advanceTimersByTime(MOUNT_GRACE_MS + 100); });
        rerender(propsFor(chain(2), { rf }));
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1);
        // React Flow reports the start of the transition we asked for.
        act(() => { result.current.onMoveStart(null, { x: 0, y: 0, zoom: 1 }); });
        expect(result.current.following).toBe(true);
        // …and ownership lapses after the move: duration 480 + 80 slack.
        act(() => { vi.advanceTimersByTime(600); });
        act(() => { result.current.onMoveStart(null, { x: 0, y: 0, zoom: 1 }); });
        expect(result.current.following).toBe(false);
    });

    it('a new build takes the camera back and the ending gives one closing wide shot', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf, structuralEditsBlocked: false }));
        act(() => { vi.advanceTimersByTime(MOUNT_GRACE_MS + 100); });
        act(() => { result.current.onMoveStart(null, {}); }); // not blocked: ignored
        expect(result.current.following).toBe(true);

        rerender(propsFor(chain(1), { rf }));
        expect(rf.fitView).toHaveBeenCalledTimes(1); // the film begins on a wide
        act(() => { result.current.onMoveStart(null, {}); });
        expect(result.current.following).toBe(true); // still ours: the wide is in flight
        act(() => { vi.advanceTimersByTime(800); });
        act(() => { result.current.onMoveStart(null, {}); });
        expect(result.current.following).toBe(false);

        // The presenter holds it: the ending moves nothing.
        rerender(propsFor(chain(1), { rf, structuralEditsBlocked: false }));
        act(() => { vi.advanceTimersByTime(3000); });
        expect(rf.fitView).toHaveBeenCalledTimes(1);

        // Next build: following again, and the end lands the closing shot.
        rerender(propsFor(chain(1), { rf }));
        expect(result.current.following).toBe(true);
        expect(rf.fitView).toHaveBeenCalledTimes(2);
        rerender(propsFor(chain(1), { rf, structuralEditsBlocked: false }));
        expect(rf.fitView).toHaveBeenCalledTimes(3);
        act(() => { vi.advanceTimersByTime(3000); });
        expect(rf.fitView).toHaveBeenCalledTimes(3);
    });

    it('summarise (phase → reviewing) is a chapter break: one wide, after the hold', () => {
        const rf = makeRf();
        const { rerender } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(2), { rf }));
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1);
        rerender(propsFor(chain(2), { rf, buildCue: cue({ phase: 'reviewing' }) }));
        act(() => { vi.advanceTimersByTime(MIN_MOVE_GAP_MS - 50); });
        expect(rf.fitView).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(100); });
        expect(rf.fitView).toHaveBeenCalledTimes(1);
    });

    it('the trigger arriving is the canvas mounting: a wide fit, not a push', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor({ steps: [], edges: [] }, { rf }));
        rerender(propsFor({ trigger: TRIGGER, steps: [], edges: [] }, { rf }));
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.fitView).toHaveBeenCalledTimes(1);
        expect(rf.fitView.mock.calls[0][0]).toEqual({ padding: 0.12, duration: 260, minZoom: 0.2, maxZoom: 1 });
        expect(rf.setViewport).not.toHaveBeenCalled();
        expect(result.current.buildFxById.get('trg')).toMatchObject({ kind: 'fresh' });
        // React Flow's own fit-on-mount fires onMoveStart with a null event a
        // frame later; that is not the presenter.
        act(() => { vi.advanceTimersByTime(100); });
        act(() => { result.current.onMoveStart(null, {}); });
        expect(result.current.following).toBe(true);
    });

    it('…even when React Flow\'s fit-on-mount lands BEFORE the hook\'s own timer has run', () => {
        // The ResizeObserver's first delivery is a rendering step; on a frame
        // that runs ahead of a 0 ms timer task, onMoveStart(null) arrives with
        // no timer having fired yet. Ownership must already be armed by then
        // (from the effect, not the shot's timer) or the whole build plays
        // with the camera "the presenter's" and a Follow button from card one.
        const rf = makeRf();
        const { result, rerender } = mount(propsFor({ steps: [], edges: [] }, { rf }));
        rerender(propsFor({ trigger: TRIGGER, steps: [], edges: [] }, { rf }));
        expect(rf.fitView).not.toHaveBeenCalled(); // no timer has run
        act(() => { result.current.onMoveStart(null, {}); });
        expect(result.current.following).toBe(true);
        act(() => { vi.advanceTimersByTime(1); });
        expect(rf.fitView).toHaveBeenCalledTimes(1);
        // And the grace holds for the whole measured mount, not just the shot.
        act(() => { vi.advanceTimersByTime(MOUNT_GRACE_MS - 200); });
        act(() => { result.current.onMoveStart(null, {}); });
        expect(result.current.following).toBe(true);
    });

    it('resumeFollow outside a build re-arms following but takes no shot — the Fit button fits on its own then', () => {
        const rf = makeRf();
        const { result } = mount(propsFor(chain(2), { rf, structuralEditsBlocked: false }));
        act(() => { result.current.resumeFollow(); });
        expect(result.current.following).toBe(true);
        expect(cameraCalls(rf)).toBe(0);
    });

    it('unmount clears the timers', () => {
        const rf = makeRf();
        const { rerender, unmount } = mount(propsFor(chain(1), { rf }));
        rerender(propsFor(chain(2), { rf }));
        act(() => { vi.advanceTimersByTime(1); });
        rerender(propsFor(chain(3), { rf }));
        unmount();
        act(() => { vi.advanceTimersByTime(5000); });
        expect(rf.setViewport).toHaveBeenCalledTimes(1);
    });
});

describe('useBuildChoreography — reduced motion', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: FAKES }); vi.setSystemTime(100000); });
    afterEach(() => { vi.useRealTimers(); });

    it('reproduces today\'s fitView on a count change while blocked — no flags, no ghost, no push', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf, reducedMotion: true }));
        // Mounting blocked is a count change from nothing: the old effect fit then too.
        act(() => { vi.advanceTimersByTime(50); });
        const afterMount = rf.fitView.mock.calls.length;
        expect(afterMount).toBe(1);
        expect(rf.fitView.mock.calls[0][0]).toEqual({ padding: 0.12, duration: 260, minZoom: 0.2, maxZoom: 1 });

        rerender(propsFor(chain(2), { rf, reducedMotion: true }));
        expect(result.current.buildFxById.size).toBe(0);
        expect(result.current.frontierId).toBeNull();
        expect(result.current.ghostNodes).toEqual([]);
        expect(result.current.freshEdgeKeys.size).toBe(0);
        // Two frames, then the fit.
        act(() => { vi.advanceTimersByTime(17); });
        expect(rf.fitView).toHaveBeenCalledTimes(afterMount);
        act(() => { vi.advanceTimersByTime(40); });
        expect(rf.fitView).toHaveBeenCalledTimes(afterMount + 1);
        expect(rf.setViewport).not.toHaveBeenCalled();
    });

    it('a draft that changes no count does not re-fit', () => {
        const rf = makeRf();
        const two = chain(2);
        const { rerender } = mount(propsFor(two, { rf, reducedMotion: true }));
        act(() => { vi.advanceTimersByTime(50); });
        const n = rf.fitView.mock.calls.length;
        const edited = { ...two, steps: two.steps.map(s => ({ ...s, label: 'x' })) };
        rerender(propsFor(edited, { rf, reducedMotion: true }));
        act(() => { vi.advanceTimersByTime(100); });
        expect(rf.fitView).toHaveBeenCalledTimes(n);
    });

    it('does not fit when the canvas is not blocked', () => {
        const rf = makeRf();
        const { rerender } = mount(propsFor(chain(1), { rf, reducedMotion: true, structuralEditsBlocked: false }));
        rerender(propsFor(chain(2), { rf, reducedMotion: true, structuralEditsBlocked: false }));
        act(() => { vi.advanceTimersByTime(100); });
        expect(cameraCalls(rf)).toBe(0);
    });

    it('never yields the camera: its own fit is an unowned programmatic move, and React Flow reports it like a wheel', () => {
        const rf = makeRf();
        const { result, rerender } = mount(propsFor(chain(1), { rf, reducedMotion: true }));
        act(() => { vi.advanceTimersByTime(50); });
        rerender(propsFor(chain(2), { rf, reducedMotion: true }));
        act(() => { vi.advanceTimersByTime(60); });
        expect(rf.fitView).toHaveBeenCalledTimes(2);
        // What React Flow does for that fit — and for a real wheel tick too.
        act(() => { result.current.onMoveStart(null, { x: 0, y: 0, zoom: 1 }); });
        act(() => { result.current.onMoveStart(new Event('wheel'), { x: 0, y: 0, zoom: 1 }); });
        expect(result.current.following).toBe(true);
        // A hand-back (Follow / Fit) adds no animated shot either: today's
        // behaviour is the count-keyed fit and nothing else.
        act(() => { result.current.resumeFollow(); });
        act(() => { vi.advanceTimersByTime(100); });
        expect(rf.fitView).toHaveBeenCalledTimes(2);
        expect(rf.setViewport).not.toHaveBeenCalled();
    });
});
