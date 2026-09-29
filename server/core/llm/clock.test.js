/**
 * core/llm/clock — the shared prompt clock.
 *
 * What is pinned: minute resolution (two instants in the same minute render
 * identically — the property that lets a self-hosted prompt cache hit at all),
 * the line shape the surfaces agree on, and that a bad zone string from a
 * client degrades instead of throwing inside prompt assembly.
 *
 * Run: cd server && node --test --test-force-exit core/llm/clock.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { formatLocalNow, utcOffsetString, nowLine, DEFAULT_TZ } = require('./clock');

const SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC[+-]\d{2}:\d{2} \([A-Za-z_]+\/[A-Za-z_]+\)$/;

test('the line has the agreed shape and no seconds', () => {
    const out = formatLocalNow('Europe/Amsterdam', { now: new Date('2026-09-11T13:04:59Z') });
    assert.match(out, SHAPE);
    assert.strictEqual(out, '2026-09-11 15:04 UTC+02:00 (Europe/Amsterdam)');
});

test('two instants in the same minute render byte-identically', () => {
    const a = formatLocalNow('Europe/Amsterdam', { now: new Date('2026-09-11T13:04:03Z') });
    const b = formatLocalNow('Europe/Amsterdam', { now: new Date('2026-09-11T13:04:58Z') });
    assert.strictEqual(a, b);
    // …and the next minute is a different line, so the clock still moves.
    const c = formatLocalNow('Europe/Amsterdam', { now: new Date('2026-09-11T13:05:00Z') });
    assert.notStrictEqual(a, c);
});

test('midnight uses 00, not 24 (hourCycle h23)', () => {
    const out = formatLocalNow('UTC', { now: new Date('2026-01-01T00:10:00Z') });
    assert.strictEqual(out, '2026-01-01 00:10 UTC+00:00 (UTC)');
});

test('the offset follows the zone and the instant (DST)', () => {
    assert.strictEqual(utcOffsetString(new Date('2026-07-01T12:00:00Z'), 'Europe/Amsterdam'), '+02:00');
    assert.strictEqual(utcOffsetString(new Date('2026-01-15T12:00:00Z'), 'Europe/Amsterdam'), '+01:00');
    assert.strictEqual(utcOffsetString(new Date('2026-01-15T12:00:00Z'), 'America/New_York'), '-05:00');
    assert.strictEqual(utcOffsetString(new Date('2026-01-15T12:00:00Z'), 'Asia/Kolkata'), '+05:30');
});

test('the output does not depend on the PROCESS zone', () => {
    // The clones this replaces re-parsed the zone's wall time in the process
    // zone, so a developer box in Amsterdam printed UTC+00:00 for Amsterdam
    // while the UTC container printed the right thing. Node re-reads TZ on
    // assignment, so the same instant is rendered under three process zones.
    const now = new Date('2026-09-11T13:04:00Z');
    const saved = process.env.TZ;
    const seen = new Set();
    try {
        for (const processTz of ['UTC', 'Europe/Amsterdam', 'America/Los_Angeles']) {
            process.env.TZ = processTz;
            seen.add(formatLocalNow('Europe/Amsterdam', { now }));
            seen.add(formatLocalNow('Europe/Amsterdam', { now }) === '2026-09-11 15:04 UTC+02:00 (Europe/Amsterdam)');
        }
    } finally {
        if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
    assert.deepStrictEqual([...seen], ['2026-09-11 15:04 UTC+02:00 (Europe/Amsterdam)', true]);
});

test('nowLine carries the Now: prefix every surface greps for', () => {
    const line = nowLine('UTC', { now: new Date('2026-09-11T13:04:00Z') });
    assert.strictEqual(line, 'Now: 2026-09-11 13:04 UTC+00:00 (UTC)');
});

test('an unknown zone falls back to the default instead of throwing', () => {
    const now = new Date('2026-09-11T13:04:00Z');
    const out = formatLocalNow('Mars/Olympus_Mons', { now });
    assert.strictEqual(out, formatLocalNow(DEFAULT_TZ, { now }));
    assert.strictEqual(formatLocalNow('', { now }), formatLocalNow(DEFAULT_TZ, { now }));
    assert.strictEqual(formatLocalNow(undefined, { now }), formatLocalNow(DEFAULT_TZ, { now }));
});
