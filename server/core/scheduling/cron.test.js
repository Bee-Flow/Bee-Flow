'use strict';

/**
 * cron.nextRunAt — semantics + the two defects the day-level rewrite fixed.
 *
 * 1. Event loop freeze (W1/FIX2). nextRunAt used to walk the 366-day window
 *    MINUTE BY MINUTE, one Intl.DateTimeFormat.formatToParts call per minute
 *    (~527k for a sparse cron), synchronously. POST /_schedule/preview calls
 *    it `count` times, so one unauthenticated-ish request pinned the whole
 *    Node process for ~64 seconds. The "…is fast" tests below fail loudly if
 *    the minute-walk ever comes back.
 * 2. DST fall-back (W1/FIX3). On the switch day the ambiguous wall time
 *    happens twice; the old code returned the LATER instant, so a 02:30
 *    automation ran at 03:30 wall clock — and in zones that switch at midnight
 *    it could return an instant in the PAST, which the scheduler claims
 *    immediately. We now always return the FIRST occurrence.
 *
 * The plain-cron expectations were captured from the pre-rewrite
 * implementation and must not drift: next_run_at for every scheduled automation
 * in the product comes from this function.
 *
 * Run: node --test automation/cron.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { parseCron, nextRunAt } = require('./cron');
const at = (iso) => Date.parse(iso);

// ── Baseline semantics (pinned against the pre-rewrite behaviour) ────────

test('daily / weekly / yearly crons resolve in the target timezone', () => {
    // 14:00 CEST → tomorrow 09:30 CEST.
    assert.strictEqual(
        nextRunAt('30 9 * * *', 'Europe/Amsterdam', at('2026-08-10T12:00:00Z')),
        '2026-08-11T07:30:00.000Z');
    // Winter: same wall clock, CET (+1) instead of CEST (+2).
    assert.strictEqual(
        nextRunAt('30 9 * * *', 'Europe/Amsterdam', at('2026-01-15T12:00:00Z')),
        '2026-01-16T08:30:00.000Z');
    // Monday 09:00 local, asked on a Monday afternoon → NEXT Monday.
    assert.strictEqual(
        nextRunAt('0 9 * * 1', 'Europe/Amsterdam', at('2026-08-10T12:00:00Z')),
        '2026-08-17T07:00:00.000Z');
    // New year's midnight, Amsterdam = 23:00Z the day before.
    assert.strictEqual(
        nextRunAt('0 0 1 1 *', 'Europe/Amsterdam', at('2026-12-20T12:00:00Z')),
        '2026-12-31T23:00:00.000Z');
    // Zones without DST and zones ahead of UTC.
    assert.strictEqual(
        nextRunAt('15 3 * * *', 'UTC', at('2026-08-10T12:00:00Z')),
        '2026-08-11T03:15:00.000Z');
    assert.strictEqual(
        nextRunAt('0 0 * * *', 'Asia/Tokyo', at('2026-08-10T12:00:00Z')),
        '2026-08-10T15:00:00.000Z');
});

test('step/list fields and the POSIX dom-OR-dow rule are unchanged', () => {
    assert.strictEqual(
        nextRunAt('*/15 * * * *', 'UTC', at('2026-08-10T12:07:30Z')),
        '2026-08-10T12:15:00.000Z');
    // Both dom and dow restricted → either may match. 2026-08-13 is a
    // Thursday, so it fires on the day-of-month alone.
    assert.strictEqual(
        nextRunAt('0 12 13 * 5', 'UTC', at('2026-08-10T12:00:00Z')),
        '2026-08-13T12:00:00.000Z');
});

test('a cron with no reachable run inside the 366-day window returns null', () => {
    // 31 February never happens.
    assert.strictEqual(nextRunAt('0 0 31 2 *', 'UTC', at('2026-08-10T12:00:00Z')), null);
    // 29 February exists, but not within 366 days of August 2026.
    assert.strictEqual(nextRunAt('0 0 29 2 *', 'UTC', at('2026-08-10T12:00:00Z')), null);
});

test('the result is always strictly in the future and lands on a whole minute', () => {
    const from = at('2026-08-10T12:00:30Z');
    for (const c of ['* * * * *', '*/5 * * * *', '0 * * * *', '30 9 * * *']) {
        const iso = nextRunAt(c, 'Europe/Amsterdam', from);
        assert.ok(Date.parse(iso) > from, `${c} must be strictly after fromTs`);
        assert.strictEqual(Date.parse(iso) % 60_000, 0, `${c} must land on a whole minute`);
    }
});

// ── FIX2: the day-level fast path ───────────────────────────────────────
//
// Wall-clock budgets, not micro-benchmarks: the minute-walk needed seconds
// per call here (and ~3.2s per call on the box where the 64s freeze was
// measured), the day scan needs milliseconds. A generous ceiling still fails
// hard if the O(minutes) scan returns.

test('a sparse cron does not freeze the event loop (was ~64s over 20 previews)', () => {
    const t0 = Date.now();
    let from = at('2026-08-10T12:00:00Z');
    const next = [];
    for (let i = 0; i < 20; i++) {
        const iso = nextRunAt('0 0 1 1 *', 'Europe/Amsterdam', from);
        if (!iso) break;
        next.push(iso);
        from = Date.parse(iso);
    }
    const elapsed = Date.now() - t0;
    assert.strictEqual(next[0], '2026-12-31T23:00:00.000Z');
    assert.ok(next.length >= 1, 'at least one preview');
    assert.ok(elapsed < 1000, `20 previews of "0 0 1 1 *" took ${elapsed}ms — the minute-by-minute scan is back`);
});

test('a cron that can never match returns null fast (was a full 527k-minute scan)', () => {
    const t0 = Date.now();
    assert.strictEqual(nextRunAt('0 0 31 2 *', 'Europe/Amsterdam', at('2026-08-10T12:00:00Z')), null);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `"0 0 31 2 *" took ${elapsed}ms — the minute-by-minute scan is back`);
});

// ── DST ─────────────────────────────────────────────────────────────────

test('spring forward: a schedule inside the missing hour skips that day', () => {
    // Europe/Amsterdam jumps 02:00 → 03:00 on 2026-03-29, so 02:30 does not
    // exist that day. Unchanged from the minute-walker, which never saw it.
    assert.strictEqual(
        nextRunAt('30 2 * * *', 'Europe/Amsterdam', at('2026-03-28T23:00:00Z')),
        '2026-03-30T00:30:00.000Z');
});

test('fall back: fires at the FIRST occurrence, not an hour late', () => {
    // 2026-10-25 Amsterdam: 03:00 CEST → 02:00 CET, so 02:30 happens at
    // 00:30Z (CEST) and again at 01:30Z (CET). Old behaviour returned
    // 01:30Z — the automation ran an hour late every autumn.
    assert.strictEqual(
        nextRunAt('30 2 * * *', 'Europe/Amsterdam', at('2026-10-24T20:00:00Z')),
        '2026-10-25T00:30:00.000Z');
    // And having fired, it advances to the NEXT day rather than firing a
    // second time in the repeated hour.
    assert.strictEqual(
        nextRunAt('30 2 * * *', 'Europe/Amsterdam', at('2026-10-25T00:30:00.000Z')),
        '2026-10-26T01:30:00.000Z');
});

test('fall back never yields a next run in the past (America/Santiago switches at midnight)', () => {
    // The old wall-clock inversion could resolve 23:10 on 2026-04-04 to the
    // FIRST occurrence while the cursor was already inside the second one,
    // handing the scheduler a next_run_at it claims immediately — the
    // every-60-seconds re-fire loop.
    for (let m = 0; m < 120; m += 7) {
        const from = at('2026-04-05T02:30:00Z') + m * 60_000;
        for (const c of ['* * * * *', '*/5 * * * *', '10 23 * * *']) {
            const iso = nextRunAt(c, 'America/Santiago', from);
            if (iso) assert.ok(Date.parse(iso) > from, `${c} @ ${new Date(from).toISOString()} → ${iso} is in the past`);
        }
    }
});

test('successive calls strictly advance across a DST boundary (no stall, no repeat)', () => {
    let from = at('2026-10-24T22:00:00Z');
    let last = 0;
    for (let i = 0; i < 40; i++) {
        const iso = nextRunAt('*/20 * * * *', 'Europe/Amsterdam', from);
        assert.ok(iso, 'must keep producing runs');
        const ts = Date.parse(iso);
        assert.ok(ts > from, 'strictly ahead of the cursor');
        assert.ok(ts > last, 'strictly increasing across iterations');
        last = ts;
        from = ts;
    }
});

// ── parser (unchanged, guarded because nextRunAt leans on it) ────────────

test('parseCron rejects malformed expressions', () => {
    assert.throws(() => parseCron('0 0 * *'), /5 fields/);
    assert.throws(() => parseCron('bogus * * * *'), /Invalid cron field/);
    assert.throws(() => parseCron('*/0 * * * *'), /Step must be/);
    // 7 is Sunday, folded onto 0.
    assert.ok(parseCron('0 0 * * 7').dow.has(0));
});
