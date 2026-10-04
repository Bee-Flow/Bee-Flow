// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    diffDefinitions,
    revealSchedule,
    orderAdded,
    nextSlotFor,
    shotFor,
    isRectInView,
    planCameraMove,
    phaseFor,
    chapterOf,
    isRefusedCall,
    COL_PITCH,
    ROW_PITCH,
    MIN_MOVE_GAP_MS,
    WRAP_HOLD_MS,
    REVEAL_STAGGER_MS,
    REVEAL_STAGGER_MIN_MS,
    REVEAL_BUDGET_MS,
    BURST_WIDE_MIN,
} from './buildChoreography';

const trigger = { id: 'trg', type: 'trigger', kind: 'manual' };
const step = (id, over = {}) => ({ id, type: 'ai_step', label: id, ...over });
const chain = (...ids) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));
const def = (steps, edges, over = {}) => ({ trigger, steps, edges, ...over });

// The demo canvas: ~1100×750 usable, as in the plan's fitted-zoom table.
const VIEW = { width: 1100, height: 750 };
// Layout box (240×96) versus what React Flow measures (240×72). fitView frames
// MEASURED nodes, so the multi-row zoom figures are computed with 72-tall cards.
const card = (col, row, height = 96) => ({ x: col * COL_PITCH, y: row * ROW_PITCH, width: 240, height });
const rowOf = (n, row = 0, height = 96) => Array.from({ length: n }, (_, i) => card(i, row, height));
const gridOf = (n, height = 96) => Array.from({ length: n }, (_, i) => card(i % 5, Math.floor(i / 5), height));

describe('diffDefinitions', () => {
    it('flags a single new step as added, with its new edge', () => {
        const prev = def([step('a')], chain('trg', 'a'));
        const next = def([step('a'), step('b')], chain('trg', 'a', 'b'));
        expect(diffDefinitions(prev, next)).toEqual({
            added: ['b'],
            removed: [],
            touched: [],
            addedEdgeKeys: ['a->b||'],
        });
    });

    it('orders an add_steps burst by flowOrder, not by authoring order', () => {
        const prev = def([step('a')], chain('trg', 'a'));
        // authoring order deliberately reversed relative to the edges
        const next = def([step('a'), step('d'), step('c'), step('b')], chain('trg', 'a', 'b', 'c', 'd'));
        const { added, addedEdgeKeys } = diffDefinitions(prev, next);
        expect(added).toEqual(['b', 'c', 'd']);
        expect(addedEdgeKeys).toEqual(['a->b||', 'b->c||', 'c->d||']);
    });

    it('treats the first draft (no previous definition) as all-added, trigger first', () => {
        const next = def([step('a')], chain('trg', 'a'));
        expect(diffDefinitions(null, next).added).toEqual(['trg', 'a']);
        expect(diffDefinitions(undefined, next).addedEdgeKeys).toEqual(['trg->a||']);
    });

    it('a removal yields one new prev→next edge key and no additions', () => {
        const prev = def([step('a'), step('b'), step('c')], chain('trg', 'a', 'b', 'c'));
        const next = def([step('a'), step('c')], chain('trg', 'a', 'c'));
        expect(diffDefinitions(prev, next)).toEqual({
            added: [],
            removed: ['b'],
            touched: [],
            addedEdgeKeys: ['a->c||'],
        });
    });

    it('a replace is a removal plus an addition', () => {
        const prev = def([step('a'), step('b'), step('c')], chain('trg', 'a', 'b', 'c'));
        const next = def([step('a'), step('d', { type: 'http_request' }), step('c')], chain('trg', 'a', 'd', 'c'));
        const out = diffDefinitions(prev, next);
        expect(out.removed).toEqual(['b']);
        expect(out.added).toEqual(['d']);
        expect(out.addedEdgeKeys).toEqual(['a->d||', 'd->c||']);
        expect(out.touched).toEqual([]);
    });

    it('a position-only change is not touched; a content change is', () => {
        const prev = def([step('a', { position: { x: 0, y: 0 } }), step('b')], chain('trg', 'a', 'b'));
        const moved = def([step('a', { position: { x: 320, y: 0 } }), step('b')], chain('trg', 'a', 'b'));
        expect(diffDefinitions(prev, moved).touched).toEqual([]);

        const edited = def([step('a', { position: { x: 320, y: 0 }, prompt: 'hello' }), step('b')], chain('trg', 'a', 'b'));
        expect(diffDefinitions(prev, edited)).toEqual({ added: [], removed: [], touched: ['a'], addedEdgeKeys: [] });
    });

});

describe('diffDefinitions — touched, ids and refusals', () => {
    it('ignores key order when deciding whether a step was touched', () => {
        const prev = def([{ id: 'a', type: 'http_request', method: 'GET', url: 'https://x' }], chain('trg', 'a'));
        const next = def([{ url: 'https://x', method: 'GET', type: 'http_request', id: 'a' }], chain('trg', 'a'));
        expect(diffDefinitions(prev, next).touched).toEqual([]);
    });

    it('a touched trigger counts too', () => {
        const prev = def([step('a')], chain('trg', 'a'));
        const next = { ...prev, trigger: { ...trigger, kind: 'schedule' } };
        expect(diffDefinitions(prev, next).touched).toEqual(['trg']);
    });

    it('handles inline-prefixed ids and secondary triggers as ordinary ids', () => {
        const prev = def([step('call')], chain('trg', 'call'));
        const next = def(
            [step('call'), step('call/inner1', { type: 'http_request' })],
            [...chain('trg', 'call'), { from: 'call', to: 'call/inner1' }, { from: 'trg2', to: 'call' }],
            { triggers: [{ id: 'trg2', type: 'trigger', kind: 'webhook' }] },
        );
        const out = diffDefinitions(prev, next);
        expect(out.added).toEqual(['trg2', 'call/inner1']);
        expect(out.addedEdgeKeys).toEqual(['call->call/inner1||', 'trg2->call||']);
    });

    it('keeps branch edges apart by label/case, like edgeKey', () => {
        const prev = def([step('route', { type: 'switch' }), step('x')], [{ from: 'trg', to: 'route' }, { from: 'route', to: 'x', label: 'case:vip', caseName: 'vip' }]);
        const next = def([step('route', { type: 'switch' }), step('x')], [
            { from: 'trg', to: 'route' },
            { from: 'route', to: 'x', label: 'case:vip', caseName: 'vip' },
            { from: 'route', to: 'x', label: 'case:default', caseName: 'default' },
        ]);
        expect(diffDefinitions(prev, next).addedEdgeKeys).toEqual(['route->x|case:default|default']);
    });

    it('a refused call re-sends an identical definition and diffs to nothing', () => {
        const a = def([step('a', { position: { x: 0, y: 0 } }), step('b')], chain('trg', 'a', 'b'));
        const b = JSON.parse(JSON.stringify(a));
        expect(diffDefinitions(a, b)).toEqual({ added: [], removed: [], touched: [], addedEdgeKeys: [] });
        expect(diffDefinitions(a, a)).toEqual({ added: [], removed: [], touched: [], addedEdgeKeys: [] });
    });
});

describe('revealSchedule', () => {
    it('a lone arrival lands at once', () => {
        const s = revealSchedule(['a']);
        expect(s.size).toBe(1);
        expect(s.get('a')).toEqual({ index: 0, delayMs: 0 });
    });

    it('N=6 cards depart one beat (1200 ms) apart, the first at 0', () => {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
        const s = revealSchedule(ids);
        expect(ids.map(id => s.get(id).delayMs)).toEqual([0, 1200, 2400, 3600, 4800, 6000]);
        expect(ids.map(id => s.get(id).index)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('N=20 tightens to 789 ms so the last card departs inside the 15 s budget', () => {
        const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
        const s = revealSchedule(ids);
        expect(s.get('s1').delayMs).toBe(789);
        const last = s.get('s19').delayMs;
        expect(last).toBeLessThanOrEqual(REVEAL_BUDGET_MS);
        expect(last).toBeGreaterThan(REVEAL_BUDGET_MS - 789);
    });

    it('two cards are a full beat apart — the budget never speeds a small burst up', () => {
        const s = revealSchedule(['a', 'b']);
        expect(s.get('b').delayMs).toBe(REVEAL_STAGGER_MS);
        expect(REVEAL_STAGGER_MS).toBe(1200);
    });

    it('the cadence table: 1200 ms up to 13 cards, tighter past that, never under 500 ms', () => {
        const stepFor = (n) => {
            const ids = Array.from({ length: n }, (_, i) => `s${i}`);
            const s = revealSchedule(ids);
            return n > 1 ? s.get('s1').delayMs : s.get('s0').delayMs;
        };
        expect(stepFor(1)).toBe(0);
        expect(stepFor(2)).toBe(1200);
        expect(stepFor(6)).toBe(1200);
        expect(stepFor(13)).toBe(1200);
        expect(stepFor(20)).toBe(789);
        expect(stepFor(31)).toBe(REVEAL_STAGGER_MIN_MS);
        expect(stepFor(60)).toBe(REVEAL_STAGGER_MIN_MS);
        expect(REVEAL_STAGGER_MIN_MS).toBe(500);
    });

    it('accepts an explicit stagger and ignores duplicates / empties', () => {
        const s = revealSchedule(['a', 'a', null, 'b'], { stagger: 100 });
        expect([...s.keys()]).toEqual(['a', 'b']);
        expect(s.get('b')).toEqual({ index: 1, delayMs: 100 });
        expect(revealSchedule([]).size).toBe(0);
        expect(revealSchedule(undefined).size).toBe(0);
    });
});

describe('orderAdded', () => {
    it('deals the hinted ids first, in the hint\'s order, then the rest in diff order', () => {
        expect(orderAdded(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b']);
        expect(orderAdded(['a', 'b', 'c'], ['b'])).toEqual(['b', 'a', 'c']);
    });

    it('falls back to diff order without a hint, and ignores hint ids the diff did not add', () => {
        expect(orderAdded(['a', 'b'], null)).toEqual(['a', 'b']);
        expect(orderAdded(['a', 'b'], undefined)).toEqual(['a', 'b']);
        expect(orderAdded(['a', 'b'], ['zzz', 'b'])).toEqual(['b', 'a']);
    });

    it('dedupes and never drops a card', () => {
        expect(orderAdded(['a', 'a', 'b', null], ['b', 'b'])).toEqual(['b', 'a']);
        expect(orderAdded(undefined, ['a'])).toEqual([]);
        expect(orderAdded([], [])).toEqual([]);
    });
});

describe('nextSlotFor', () => {
    it('advances one column pitch inside the row', () => {
        expect(nextSlotFor({ x: 320, y: 0, width: 240, height: 96 })).toEqual({ x: 640, y: 0 });
        expect(nextSlotFor({ x: 0, y: 366 })).toEqual({ x: 320, y: 366 });
    });

    it('wraps from column 5 to the first column of the next row', () => {
        const rowTop = ROW_PITCH; // frontier on row 2
        expect(nextSlotFor({ x: 4 * 320, y: rowTop, width: 240, height: 96 })).toEqual({ x: 0, y: rowTop + 366 });
        expect(nextSlotFor({ x: 4 * 320, y: 0 })).toEqual({ x: 0, y: 366 });
    });

    it('reads a rect a fraction off the grid as its nearest column', () => {
        expect(nextSlotFor({ x: 1279.6, y: 0 })).toEqual({ x: 0, y: 366 });
        expect(nextSlotFor({ x: 960.4, y: 0 })).toEqual({ x: 1280.4, y: 0 });
    });

    it('honours custom geometry', () => {
        expect(nextSlotFor({ x: 200, y: 10 }, { colWidth: 100, cols: 3, rowPitch: 50 })).toEqual({ x: 0, y: 60 });
        expect(nextSlotFor({ x: 100, y: 10 }, { colWidth: 100, cols: 3, rowPitch: 50 })).toEqual({ x: 200, y: 10 });
    });
});

describe('shotFor', () => {
    it('push: the 3-slot window (predecessor, new card, ghost) lands at zoom 1.0', () => {
        const rects = rowOf(2);
        const ghostRect = card(2, 0);
        const shot = shotFor({ kind: 'push', rects, ghostRect, viewport: VIEW, current: { x: 0, y: 0, zoom: 0.647 } });
        expect(shot.zoom).toBe(1);
        expect(shot.duration).toBe(480);
        expect(shot.interpolate).toBe('smooth');
        // 880 px frame centred in 1100: 110 px each side, well inside the 71 px padding
        expect(shot.x).toBeCloseTo(110, 5);
        expect(shot.y).toBeCloseTo(375 - 48, 5);
    });

    it('push: a 4-slot window (three cards + ghost) cannot reach 1.0 and sits on the 0.85 floor, biased to the newest card', () => {
        const rects = rowOf(3);
        const ghostRect = card(3, 0);
        const shot = shotFor({ kind: 'push', rects, ghostRect, viewport: VIEW, current: { x: 0, y: 0, zoom: 0.85 } });
        expect(shot.zoom).toBe(0.85);
        expect(shot.interpolate).toBe('linear');
        // The newest card (x 640..880) and the ghost stay fully inside the padded frame…
        expect(isRectInView(rects[2], shot, VIEW, 71)).toBe(true);
        expect(isRectInView(ghostRect, shot, VIEW, 71)).toBe(true);
        // …at the expense of the oldest card, which the bias lets slide off the left.
        expect(isRectInView(rects[0], shot, VIEW, 0)).toBe(false);
    });

    it('push: the bias only spends slack — the frame never leaves the padding when it fits', () => {
        // newest card on the right of a short window: centre shifts right, but the
        // left card must keep its 71 px padding.
        const rects = [card(0, 0), card(1, 0)];
        const shot = shotFor({ kind: 'push', rects, ghostRect: null, viewport: VIEW });
        expect(shot.zoom).toBe(1);
        const left = rects[0].x * shot.zoom + shot.x;
        const right = (rects[1].x + rects[1].width) * shot.zoom + shot.x;
        expect(left).toBeGreaterThanOrEqual(71);
        expect(right).toBeLessThanOrEqual(1100 - 71);
        // and it did move toward the newest card compared with a plain centring
        expect(left).toBeLessThan((1100 - 560) / 2);
    });

    it('wide: a whole 6-card graph (5 columns + 1 on the next row) fits at ≈ 0.647', () => {
        const rects = gridOf(6, 72);
        const shot = shotFor({ kind: 'wide', rects, ghostRect: card(1, 1, 72), viewport: VIEW, current: { x: 0, y: 0, zoom: 1 } });
        expect(shot.zoom).toBeCloseTo(0.647, 2);
        expect(Math.abs(shot.zoom - 0.647)).toBeLessThan(0.01);
        expect(shot.duration).toBe(700);
        expect(shot.interpolate).toBe('smooth');
    });

    it('wide: 4 cards in a row → ≈ 0.82', () => {
        const shot = shotFor({ kind: 'wide', rects: rowOf(4), ghostRect: null, viewport: VIEW });
        expect(Math.abs(shot.zoom - 0.82)).toBeLessThan(0.01);
    });

    it('wide: 21 cards over 5 rows → ≈ 0.44 (far LOD)', () => {
        const shot = shotFor({ kind: 'wide', rects: gridOf(21, 72), ghostRect: null, viewport: VIEW });
        expect(Math.abs(shot.zoom - 0.44)).toBeLessThan(0.01);
        expect(shot.zoom).toBeLessThan(0.45);
    });

    it('wide: 2–3 cards clamp to maxZoom 1 and centre the frame', () => {
        const shot = shotFor({ kind: 'wide', rects: rowOf(3), ghostRect: null, viewport: VIEW });
        expect(shot.zoom).toBe(1);
        // frame 880 wide (two pitches + a card), centred → 110 px each side
        expect(shot.x).toBeCloseTo(110, 5);
    });

    it('wide: matches React Flow padding maths — 5.3 % a side for 0.12, not 12 %', () => {
        // A frame exactly as wide as the usable 984 px fits at zoom 1 only under the real formula.
        const shot = shotFor({ kind: 'wide', rects: [{ x: 0, y: 0, width: 984, height: 96 }], ghostRect: null, viewport: VIEW });
        expect(shot.zoom).toBe(1);
        const naive = shotFor({ kind: 'wide', rects: [{ x: 0, y: 0, width: 1000, height: 96 }], ghostRect: null, viewport: VIEW });
        expect(naive.zoom).toBeCloseTo(984 / 1000, 5);
    });

    it('the ghost rect widens the frame for both shots', () => {
        const without = shotFor({ kind: 'wide', rects: rowOf(4), ghostRect: null, viewport: VIEW });
        const withGhost = shotFor({ kind: 'wide', rects: rowOf(4), ghostRect: card(4, 0), viewport: VIEW });
        expect(withGhost.zoom).toBeLessThan(without.zoom);
        expect(Math.abs(withGhost.zoom - 0.647)).toBeLessThan(0.01);
    });

    it('returns null with nothing to frame, no viewport or an unknown kind', () => {
        expect(shotFor({ kind: 'push', rects: [], ghostRect: null, viewport: VIEW })).toBeNull();
        expect(shotFor({ kind: 'wide', rects: rowOf(2), viewport: { width: 0, height: 0 } })).toBeNull();
        expect(shotFor({ kind: 'dolly', rects: rowOf(2), viewport: VIEW })).toBeNull();
        expect(shotFor()).toBeNull();
    });
});

describe('isRectInView', () => {
    const viewport = { x: 110, y: 327, zoom: 1 };

    it('is true for a card fully inside the frame minus the margin', () => {
        expect(isRectInView(card(1, 0), viewport, VIEW)).toBe(true);
    });

    it('is false when any side crosses the margin', () => {
        expect(isRectInView(card(3, 0), viewport, VIEW)).toBe(false); // right edge at 1310
        expect(isRectInView({ x: -70, y: 0, width: 240, height: 96 }, viewport, VIEW)).toBe(false); // left at 40 < 48
        expect(isRectInView({ x: -70, y: 0, width: 240, height: 96 }, viewport, VIEW, 40)).toBe(true);
        expect(isRectInView(card(1, 1), viewport, VIEW)).toBe(false); // bottom at 327 + 462 = 789 > 702
    });

    it('projects through the zoom', () => {
        const zoomed = { x: 0, y: 0, zoom: 0.5 };
        expect(isRectInView({ x: 2000, y: 200, width: 240, height: 96 }, zoomed, VIEW)).toBe(false); // right edge at 1120 > 1052
        expect(isRectInView({ x: 1800, y: 200, width: 240, height: 96 }, zoomed, VIEW)).toBe(true); // 900..1020, 100..148
    });

    it('is false for missing inputs', () => {
        expect(isRectInView(null, viewport, VIEW)).toBe(false);
        expect(isRectInView(card(0, 0), null, VIEW)).toBe(false);
        expect(isRectInView(card(0, 0), viewport, null)).toBe(false);
    });
});

describe('planCameraMove', () => {
    it('an arrival is a push-in once the hold has elapsed', () => {
        expect(planCameraMove({ reason: 'arrival', following: true, lastMoveAt: 0, now: 5000 }))
            .toEqual({ moves: ['push'], holdMs: MIN_MOVE_GAP_MS, deferMs: 0 });
        expect(planCameraMove({ reason: 'arrival', following: true, lastMoveAt: null, now: 10 }).deferMs).toBe(0);
    });

    it('a second move within 1200 ms is deferred by the remainder of the hold', () => {
        const plan = planCameraMove({ reason: 'arrival', following: true, lastMoveAt: 1000, now: 1400 });
        expect(plan.moves).toEqual(['push']);
        expect(plan.deferMs).toBe(800);
        expect(planCameraMove({ reason: 'end', following: true, lastMoveAt: 1000, now: 2199 }).deferMs).toBe(1);
        expect(planCameraMove({ reason: 'end', following: true, lastMoveAt: 1000, now: 2200 }).deferMs).toBe(0);
    });

    it('once the presenter holds the camera nothing moves it', () => {
        expect(planCameraMove({ reason: 'arrival', following: false, lastMoveAt: 0, now: 5000 })).toBeNull();
        expect(planCameraMove({ reason: 'end', following: false, lastMoveAt: 0, now: 5000 })).toBeNull();
        expect(planCameraMove({ reason: 'arrival', following: false, rowWrapped: true, now: 5000 })).toBeNull();
    });

    it('a row wrap is wide, then push, 900 ms apart', () => {
        const plan = planCameraMove({ reason: 'arrival', following: true, lastMoveAt: 0, now: 5000, rowWrapped: true });
        expect(plan).toEqual({ moves: ['wide', 'push'], holdMs: WRAP_HOLD_MS, deferMs: 0 });
        expect(planCameraMove({ reason: 'wrap', following: true, now: 5000 }).moves).toEqual(['wide', 'push']);
        // the 1200 ms hold still applies before the wide shot
        expect(planCameraMove({ reason: 'arrival', following: true, lastMoveAt: 4600, now: 5000, rowWrapped: true }).deferMs).toBe(800);
    });

    it('chapter breaks are one wide shot', () => {
        for (const reason of ['burst_end', 'remove', 'replace', 'move', 'summarise', 'dry_run', 'finalize', 'end', 'resume']) {
            expect(planCameraMove({ reason, following: true, lastMoveAt: 0, now: 5000 }).moves).toEqual(['wide']);
        }
    });

    it('a burst is no longer a chapter break at its START — only its end is, and only from three cards', () => {
        // The old `burst` reason cued one wide shot at t≈0 while every card was
        // still invisible; the camera then sat on an empty frame for the reveal.
        expect(planCameraMove({ reason: 'burst', following: true, lastMoveAt: 0, now: 5000 })).toBeNull();
        expect(planCameraMove({ reason: 'burst_end', following: true, lastMoveAt: 0, now: 5000 }).moves).toEqual(['wide']);
        // …and a burst_end on a row wrap still shows the new row, then comes back in.
        expect(planCameraMove({ reason: 'burst_end', following: true, lastMoveAt: 0, now: 5000, rowWrapped: true }).moves).toEqual(['wide', 'push']);
        expect(BURST_WIDE_MIN).toBe(3);
    });

    it('an on-screen update, a refusal or an unknown reason never move the camera', () => {
        expect(planCameraMove({ reason: 'update', following: true, lastMoveAt: 0, now: 5000 })).toBeNull();
        expect(planCameraMove({ reason: 'refusal', following: true, lastMoveAt: 0, now: 5000 })).toBeNull();
        expect(planCameraMove({ reason: 'update', following: true, rowWrapped: true, now: 5000 })).toBeNull();
        expect(planCameraMove({ following: true, now: 5000 })).toBeNull();
        expect(planCameraMove()).toBeNull();
    });
});

describe('phaseFor', () => {
    it('reads the chapter off the tool name', () => {
        expect(phaseFor('builder_summarise')).toBe('reviewing');
        expect(phaseFor('builder_request_dry_run')).toBe('testing');
        expect(phaseFor('builder_finalize')).toBe('finishing');
    });

    it('everything else — including no tool yet — is building', () => {
        expect(phaseFor('builder_add_step')).toBe('building');
        expect(phaseFor('builder_set_plan')).toBe('building');
        expect(phaseFor(null)).toBe('building');
        expect(phaseFor(undefined)).toBe('building');
    });
});

describe('chapterOf — the turn\'s chapter from its accepted calls', () => {
    const ok = (name) => ({ name, arguments: {}, result: { ok: true } });
    const refused = (name) => ({ name, arguments: {}, result: { error: 'The HTTP app is not connected' } });

    it('reads the phase off the last ACCEPTED call, so a refusal is never a chapter break', () => {
        expect(chapterOf([ok('builder_add_step'), refused('builder_finalize')]).phase).toBe('building');
        expect(chapterOf([ok('builder_add_step'), refused('builder_summarise')]).phase).toBe('building');
        expect(chapterOf([ok('builder_add_step'), refused('builder_request_dry_run')]).phase).toBe('building');
        expect(chapterOf([ok('builder_add_step'), ok('builder_finalize')]).phase).toBe('finishing');
    });

    it('a refused mutator after a summarise does not re-open the building chapter', () => {
        expect(chapterOf([ok('builder_summarise'), refused('builder_add_http_request')]).phase).toBe('reviewing');
        expect(chapterOf([ok('builder_summarise'), ok('builder_add_http_request')]).phase).toBe('building');
    });

    it('finalized only when this turn\'s own finalize went through', () => {
        expect(chapterOf([ok('builder_add_step'), ok('builder_finalize')]).finalized).toBe(true);
        expect(chapterOf([ok('builder_add_step'), refused('builder_finalize')]).finalized).toBe(false);
        expect(chapterOf([ok('builder_add_step')]).finalized).toBe(false);
        // A finalize followed by more edits still counts: the automation was written this turn.
        expect(chapterOf([ok('builder_finalize'), ok('builder_add_step')])).toEqual({ phase: 'building', finalized: true });
    });

    it('no calls, junk, or a non-object result → building, not finalized', () => {
        expect(chapterOf(null)).toEqual({ phase: 'building', finalized: false });
        expect(chapterOf([])).toEqual({ phase: 'building', finalized: false });
        expect(chapterOf([null, { result: {} }, { name: 'builder_finalize', result: 'ok' }])).toEqual({ phase: 'finishing', finalized: true });
    });

    it('isRefusedCall reads exactly the shape the stream hook stores', () => {
        expect(isRefusedCall(refused('x'))).toBe(true);
        expect(isRefusedCall(ok('x'))).toBe(false);
        expect(isRefusedCall({ name: 'x', result: { error: '' } })).toBe(false);
        expect(isRefusedCall({ name: 'x', result: ['error'] })).toBe(false);
        expect(isRefusedCall({ name: 'x' })).toBe(false);
        expect(isRefusedCall(null)).toBe(false);
    });
});
