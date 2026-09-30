'use strict';

/**
 * Retention thinning for version histories (core/versioning/retention.js).
 *
 * Pinned: every version younger than 48 h stays; then one per hour to 14
 * days, one per day to 90 days and one per week after that, the NEWEST of
 * each bucket kept; named, pinned, created and restore versions and any
 * referenced id are never returned; the newest version always stays; the
 * per-item cap removes the oldest free versions first; bad input thins
 * nothing. A hidden version (folded into a later save, not listed) never
 * holds a bucket, and goes once it is past the keep-all window.
 *
 * Run: cd server && node --test core/versioning/retention.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { selectPrunable, MAX_PER_ITEM } = require('./retention');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const H = 60 * 60 * 1000;
const D = 24 * H;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const v = (id, msAgo, extra = {}) => ({ id, createdAt: at(msAgo), source: 'checkpoint', ...extra });

test('keeps every version younger than 48 hours', () => {
    const rows = [v('a', 1 * H), v('b', 2 * H), v('c', 3 * H), v('d', 47 * H)];
    assert.deepStrictEqual(selectPrunable(rows, NOW), []);
});

test('keeps one version per hour between 48 hours and 14 days: the newest of the hour', () => {
    const base = 3 * D; // an hour bucket three days back
    const hourStart = Math.floor((NOW - base) / H) * H;
    const inHour = (id, minutes) => ({ id, createdAt: new Date(hourStart + minutes * 60_000).toISOString(), source: 'checkpoint' });
    const rows = [v('head', 0), inHour('h10', 10), inHour('h40', 40), inHour('h55', 55)];
    assert.deepStrictEqual(selectPrunable(rows, NOW), ['h10', 'h40']);
});

test('keeps one per day between 14 and 90 days, and one per week after that', () => {
    const dayStart = Math.floor((NOW - 20 * D) / D) * D;
    const inDay = (id, hours) => ({ id, createdAt: new Date(dayStart + hours * H).toISOString(), source: 'autosave' });
    const daily = selectPrunable([v('head', 0), inDay('d1', 1), inDay('d9', 9), inDay('d23', 23)], NOW);
    assert.deepStrictEqual(daily, ['d1', 'd9']);

    // Two versions two days apart inside one Monday-based week, 120 days back.
    const weekMonday = Math.floor(((NOW - 120 * D) / D + 3) / 7) * 7 - 3;
    const mon = new Date((weekMonday + 0) * D + 2 * H).toISOString();
    const wed = new Date((weekMonday + 2) * D + 2 * H).toISOString();
    const nextMon = new Date((weekMonday + 7) * D + 2 * H).toISOString();
    const weekly = selectPrunable([
        v('head', 0),
        { id: 'mon', createdAt: mon, source: 'checkpoint' },
        { id: 'wed', createdAt: wed, source: 'checkpoint' },
        { id: 'nextMon', createdAt: nextMon, source: 'checkpoint' },
    ], NOW);
    assert.deepStrictEqual(weekly, ['mon']);
});

test('never prunes named, pinned, created, restore or referenced versions', () => {
    const hourStart = Math.floor((NOW - 5 * D) / H) * H;
    const inHour = (id, minutes, extra) => ({ id, createdAt: new Date(hourStart + minutes * 60_000).toISOString(), source: 'checkpoint', ...extra });
    const rows = [
        v('head', 0),
        inHour('named', 1, { source: 'named', name: 'Sent to board' }),
        inHour('label', 2, { name: 'Draft 2' }),
        inHour('pinned', 3, { pinned: true }),
        inHour('created', 4, { source: 'created' }),
        inHour('pre', 5, { source: 'pre_restore' }),
        inHour('restore', 6, { source: 'restore' }),
        inHour('ref', 7),
        inHour('flagged', 8, { referenced: true }),
        inHour('plain1', 9),
        inHour('plain2', 10),
    ];
    const out = selectPrunable(rows, NOW, { referencedIds: ['ref'] });
    // Only the older of the two plain versions of that hour goes.
    assert.deepStrictEqual(out, ['plain1']);
});

test('the newest version always stays, even when it is old and alone in a crowded bucket', () => {
    const dayStart = Math.floor((NOW - 40 * D) / D) * D;
    const rows = [
        { id: 'older', createdAt: new Date(dayStart + 1 * H).toISOString(), source: 'autosave' },
        { id: 'newest', createdAt: new Date(dayStart + 2 * H).toISOString(), source: 'autosave' },
    ];
    assert.deepStrictEqual(selectPrunable(rows, NOW), []);
});

test('caps the free versions per item, oldest first', () => {
    const rows = [v('head', 0)];
    // Twelve versions in twelve different hours, all within the keep-all window.
    for (let i = 1; i <= 12; i += 1) rows.push(v(`r${i}`, i * H));
    const out = selectPrunable(rows, NOW, { maxPerItem: 10 });
    assert.deepStrictEqual(out, ['r12', 'r11']);
    assert.ok(MAX_PER_ITEM >= 1000);
});

test('thins nothing from bad input, and ignores rows without a readable time', () => {
    assert.deepStrictEqual(selectPrunable(null, NOW), []);
    assert.deepStrictEqual(selectPrunable([v('only', 10 * D)], NOW), []);
    assert.deepStrictEqual(selectPrunable([v('a', 1)], 'not a date'), []);
    const hourStart = Math.floor((NOW - 4 * D) / H) * H;
    const rows = [
        v('head', 0),
        { id: 'broken', createdAt: 'yesterday-ish', source: 'checkpoint' },
        { id: 'x1', createdAt: new Date(hourStart + 60_000).toISOString(), source: 'checkpoint' },
        { id: 'x2', createdAt: new Date(hourStart + 120_000).toISOString(), source: 'checkpoint' },
    ];
    assert.deepStrictEqual(selectPrunable(rows, NOW), ['x1']);
});

test('is stable: running it again over what it kept returns nothing more', () => {
    const rows = [v('head', 0)];
    for (let i = 1; i <= 400; i += 1) rows.push(v(`r${i}`, i * 37 * 60_000 + 50 * H));
    const first = new Set(selectPrunable(rows, NOW));
    assert.ok(first.size > 0);
    const kept = rows.filter((r) => !first.has(r.id));
    assert.deepStrictEqual(selectPrunable(kept, NOW), []);
});

test('a hidden version never holds a bucket: the listed state of the hour stays, the folded rows go', () => {
    // Three days back. Anna's session ends at 10:20 (a10 listed, a1..a9 folded
    // into it). Bob's session runs 10:30-11:14 across the hour: b1..b12 fall
    // in the 10:00 hour and are all folded into his listed head b20 at 11:14.
    const hourStart = Math.floor((NOW - 3 * D) / H) * H;
    const atMin = (id, minutes, extra = {}) => ({ id, createdAt: new Date(hourStart + minutes * 60_000).toISOString(), source: 'autosave', ...extra });
    const rows = [v('head', 0), atMin('created', -60, { source: 'created' })];
    for (let i = 1; i <= 10; i += 1) rows.push(atMin(`a${i}`, 2 * i, { hidden: i < 10 }));
    for (let i = 1; i <= 12; i += 1) rows.push(atMin(`b${i}`, 28 + 2 * i, { hidden: true }));
    for (let i = 13; i <= 20; i += 1) rows.push(atMin(`b${i}`, 60 + (i - 13) * 2, { hidden: i < 20 }));
    const pruned = new Set(selectPrunable(rows, NOW));
    const kept = rows.map((r) => r.id).filter((id) => !pruned.has(id));
    assert.deepStrictEqual(kept, ['head', 'created', 'a10', 'b20'],
        'one listed version per hour; every folded row past 48 hours goes');
});

test('a hidden version inside the keep-all window stays, and a referenced one stays at any age', () => {
    const rows = [
        v('head', 0),
        v('young-folded', 3 * H, { hidden: true }),
        v('young-listed', 3 * H + 60_000),
        v('old-folded', 5 * D, { hidden: true }),
        v('seen-folded', 5 * D + 60_000, { hidden: true }),
        v('old-listed', 5 * D + 120_000),
    ];
    assert.deepStrictEqual(selectPrunable(rows, NOW, { referencedIds: ['seen-folded'] }), ['old-folded']);
});
