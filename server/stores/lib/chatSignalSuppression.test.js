'use strict';

/**
 * Read-time suppression of chat signals: small numbers never leave a reader
 * as numbers, a single small cell cannot be recovered by subtraction, and
 * employee windows cover completed ISO weeks only.
 *
 * Run: cd server && node --test stores/lib/chatSignalSuppression.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const s = require('./chatSignalSuppression');

/** Walk a figure and collect every number and string leaf. */
function leaves(v, out = []) {
    if (v === null || typeof v !== 'object') { out.push(v); return out; }
    for (const x of Object.values(v)) leaves(x, out);
    return out;
}
const SAFE_STRINGS = new Set(['<5', 'hidden', 'shown', 'suppressed', 'off', 'no_data', '5-9', '10-24', '25+']);
function assertOnlySafe(fig) {
    for (const leaf of leaves(fig)) {
        if (leaf === null) continue;
        if (typeof leaf === 'number') assert.ok(leaf === 0 || leaf >= 5, `number ${leaf} leaked`);
        else assert.ok(SAFE_STRINGS.has(leaf), `value ${JSON.stringify(leaf)} leaked`);
    }
}

test('band: 0 stays 0, 1-4 read "<5", 5 and up are shown', () => {
    assert.equal(s.band(0), 0);
    for (const n of [1, 2, 3, 4]) assert.equal(s.band(n), '<5');
    assert.equal(s.band(5), 5);
    assert.equal(s.band(123), 123);
    assert.equal(s.band(-3), 0);
});

test('contributorBand edges', () => {
    assert.equal(s.contributorBand(null), null);
    assert.equal(s.contributorBand(undefined), null);
    assert.equal(s.contributorBand(0), '<5');
    assert.equal(s.contributorBand(4), '<5');
    assert.equal(s.contributorBand(5), '5-9');
    assert.equal(s.contributorBand(9), '5-9');
    assert.equal(s.contributorBand(10), '10-24');
    assert.equal(s.contributorBand(24), '10-24');
    assert.equal(s.contributorBand(25), '25+');
});

test('suppressCells: one small cell hides the smallest shown one; two small cells do not; zeros stay', () => {
    assert.deepEqual(s.suppressCells({ a: 30, b: 3, c: 12, d: 0 }), { a: 30, b: '<5', c: 'hidden', d: 0 });
    assert.deepEqual(s.suppressCells({ a: 30, b: 3, c: 2, d: 0 }), { a: 30, b: '<5', c: '<5', d: 0 });
    assert.deepEqual(s.suppressCells({ a: 30, b: 0 }), { a: 30, b: 0 });
    assert.deepEqual(s.suppressCells({ a: 4, b: 0 }), { a: '<5', b: 0 }, 'nothing else shown: nothing to hide');
});

test('pct: numerator under 5 reads "<5", a hidden source reads "hidden", no denominator reads null', () => {
    assert.equal(s.pct(3, 100), '<5');
    assert.equal(s.pct(0, 100), 0);
    assert.equal(s.pct(50, 100, { hiddenIfAny: [50, 'hidden'] }), 'hidden');
    assert.equal(s.pct(5, 0), null);
    assert.equal(s.pct(25, 100), 25);
    assert.equal(s.pct(1, 3), '<5');
});

test('windowFor: completed ISO weeks only, from the first full week after the start, with a 7-day floor', () => {
    // Wednesday 2026-10-21. The current week (Monday 10-19) is not complete.
    const today = '2026-10-21';
    const w = s.windowFor('direct', { days: 30, today });
    assert.equal(w.granularity, 'week');
    assert.equal(w.to, '2026-10-12', 'the last completed week starts 10-12');
    assert.equal(w.from, '2026-09-21', '30 days back is 09-21, a Monday');
    assert.equal(w.toExclusive, '2026-10-19');

    // Started on Wednesday 10-07: its week is partial, the first full week is 10-12.
    const started = s.windowFor('direct', { days: 30, today, effectiveFrom: '2026-10-07T09:00:00.000Z' });
    assert.deepEqual([started.from, started.to], ['2026-10-12', '2026-10-12']);

    // Started on Monday 10-12 at 09:00: that week is partial too.
    assert.equal(s.windowFor('agent', { today, effectiveFrom: '2026-10-12T09:00:00.000Z' }), null);
    // Started on Monday 10-12 at midnight: that week counts.
    assert.equal(s.windowFor('agent', { today, effectiveFrom: '2026-10-12T00:00:00.000Z' }).from, '2026-10-12');

    // Started this week: no completed week yet.
    assert.equal(s.windowFor('direct', { today, effectiveFrom: '2026-10-19T00:00:00.000Z' }), null);

    // A 1-day request still reads one whole week.
    const floor = s.windowFor('direct', { days: 1, today });
    assert.equal(floor.to, '2026-10-12');
    assert.ok(floor.from <= floor.to);
});

test('windowFor: website visitors read completed UTC days from the start day', () => {
    const w = s.windowFor('agent_public', { days: 30, today: '2026-10-21', effectiveFrom: '2026-10-14T09:00:00.000Z' });
    assert.deepEqual(w, { granularity: 'day', from: '2026-10-14', to: '2026-10-20', toExclusive: '2026-10-21' });
    assert.equal(s.windowFor('agent_public', { today: '2026-10-21', effectiveFrom: '2026-10-21T08:00:00.000Z' }), null);
});

test('periodStart: the ISO-week Monday for weeks, the UTC date for days', () => {
    const sunday = new Date('2026-10-18T23:30:00.000Z');
    assert.equal(s.periodStart('week', sunday), '2026-10-12');
    assert.equal(s.periodStart('week', new Date('2026-10-19T00:00:00.000Z')), '2026-10-19');
    assert.equal(s.periodStart('day', sunday), '2026-10-18');
});

const ROWS = [
    { value: 'clean', destination: 'external', provider_type: 'openai', turns: 30 },
    { value: 'protected', destination: 'external', provider_type: 'openai', turns: 3 },
    { value: 'sent_unprotected', destination: 'external', provider_type: 'openai', turns: 12 },
    { value: 'unscanned', destination: 'unknown', provider_type: '', turns: 6 },
];

test('surfaceFigures: an employee surface with 4 people is suppressed and says nothing else', () => {
    assert.deepEqual(s.surfaceFigures({ outcomeRows: ROWS, contributors: 4, surface: 'direct', kindsActive: true }), { status: 'suppressed', k: 5 });
    assert.deepEqual(s.surfaceFigures({ outcomeRows: ROWS, contributors: null, surface: 'agent' }), { status: 'suppressed', k: 5 });
});

test('surfaceFigures: kinds with 9 people are suppressed while outcomes show', () => {
    const kindRows = [
        { value: 'email', protection: 'protected', turns: 12 },
        { value: 'email', protection: 'exposed', turns: 2 },
        { value: 'name', protection: 'protected', turns: 7 },
    ];
    const fig = s.surfaceFigures({ outcomeRows: ROWS, kindRows, contributors: 9, surface: 'direct', kindsActive: true });
    assert.equal(fig.status, 'shown');
    assert.equal(fig.contributors, '5-9');
    assert.equal(fig.turns, 51);
    assert.deepEqual(fig.kinds, { status: 'suppressed', k: 10 });
    assert.deepEqual(fig.outcomes, {
        clean: 30, protected: '<5', blocked: 0, sent_unprotected: 12,
        scan_failed_open: 0, scan_failed_closed: 0, unscanned: 'hidden',
    }, 'the smallest shown cell (unscanned, 6) is hidden next to the single "<5"');
    assert.equal(fig.pct.unscanned_external, 'hidden', 'a hidden cell cannot come back as a percentage');
    assert.equal(fig.pct.sent_unprotected, 24);
    assert.equal(fig.pct.protected_of_found, '<5', 'protected + blocked = 3');
    assertOnlySafe(fig);

    const ten = s.surfaceFigures({ outcomeRows: ROWS, kindRows, contributors: 10, surface: 'direct', kindsActive: true });
    assert.equal(ten.kinds.status, 'shown');
    assert.deepEqual(ten.kinds.rows.email, { protected: 12, exposed: '<5' });
    assertOnlySafe(ten);
});

test('surfaceFigures: website visitors have no contributor gate; kinds off reads off', () => {
    const fig = s.surfaceFigures({ outcomeRows: ROWS, surface: 'agent_public', kindsActive: false });
    assert.equal(fig.status, 'shown');
    const visible = s.surfaceFigures({ outcomeRows: ROWS.filter(r => r.value !== 'protected'), surface: 'agent_public' });
    assert.equal(visible.pct.unscanned_external, 13, 'unknown destinations count as external (6 of 48)');
    assert.ok(!('contributors' in fig));
    assert.deepEqual(fig.kinds, { status: 'off' });
    assertOnlySafe(fig);
});

test('surfaceFigures: no turns reads no_data; output never holds a raw number under 5', () => {
    const empty = s.surfaceFigures({ outcomeRows: [], contributors: 30, surface: 'direct' });
    assert.equal(empty.status, 'no_data');
    assert.equal(empty.turns, 0);
    for (let n = 1; n < 12; n++) {
        const fig = s.surfaceFigures({
            outcomeRows: [{ value: 'clean', destination: 'internal', turns: n }, { value: 'blocked', destination: 'internal', turns: 1 }],
            kindRows: [{ value: 'phone', protection: 'protected', turns: 1 }],
            contributors: 25, surface: 'direct', kindsActive: true,
        });
        assertOnlySafe(fig);
    }
});
