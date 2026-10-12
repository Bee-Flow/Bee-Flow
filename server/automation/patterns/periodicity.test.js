// @typecheck
'use strict';
/**
 * Run: node --test automation/patterns/periodicity.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { cadenceOf, median, coefficientOfVariation, isTimeZone, zoneOffsetMinutes } = require('./periodicity');

const DAY = 86_400_000;
// Saturday 3 October 2026.
const TODAY = Date.UTC(2026, 9, 3);
const NOW = TODAY + 18 * 3_600_000;
const at = (daysAgo, h = 9) => TODAY - daysAgo * DAY + h * 3_600_000;
const wd = (daysAgo) => new Date(at(daysAgo)).getUTCDay();
const days = (pred, span = 90) => [...Array(span).keys()].filter(pred);

test('median and coefficient of variation', () => {
    assert.strictEqual(median([3, 1, 2]), 2);
    assert.strictEqual(median([1, 2, 3, 4]), 2.5);
    assert.strictEqual(coefficientOfVariation([7, 7, 7]), 0);
    assert.ok(coefficientOfVariation([1, 20, 3]) > 0.8);
});

test('weekly on Monday at nine', () => {
    const c = cadenceOf(days((d) => wd(d) === 1).map((d) => at(d, 9)), { now: NOW });
    assert.strictEqual(c.kind, 'weekly');
    assert.strictEqual(c.weekday, 1);
    assert.deepStrictEqual(c.hourBand, [9, 10]);
    assert.strictEqual(c.weekdayHistogram[1], 13);
    assert.strictEqual(c.weeksPresent, 13);
    assert.strictEqual(c.weeksWindow, 13);
    assert.strictEqual(c.recentWeeks, 6);
    assert.strictEqual(c.perMonth, 4.3);
});

test('weekdays only versus every day', () => {
    assert.strictEqual(cadenceOf(days((d) => wd(d) >= 1 && wd(d) <= 5).map((d) => at(d)), { now: NOW }).kind, 'weekdays');
    assert.strictEqual(cadenceOf(days(() => true).map((d) => at(d)), { now: NOW }).kind, 'daily');
});

test('biweekly and monthly', () => {
    const bi = cadenceOf(days((d) => wd(d) === 3).filter((_, i) => i % 2 === 0).map((d) => at(d)), { now: NOW });
    assert.strictEqual(bi.kind, 'biweekly');
    const mo = cadenceOf([4, 35, 65].map((d) => at(d, 16)), { now: NOW });
    assert.strictEqual(mo.kind, 'monthly');
    assert.strictEqual(mo.monthsPresent, 3);
});

test('fixed days several times a week are weekly, without one weekday', () => {
    const c = cadenceOf(days((d) => [1, 3, 5].includes(wd(d))).map((d) => at(d, 11)), { now: NOW });
    assert.strictEqual(c.kind, 'weekly');
    assert.strictEqual(c.weekday, undefined);
    assert.deepStrictEqual([c.weekdayHistogram[1], c.weekdayHistogram[3], c.weekdayHistogram[5]], [13, 13, 13]);
    assert.strictEqual(c.perMonth, 13);
});

test('irregular when the gaps scatter', () => {
    const c = cadenceOf([1, 2, 9, 30, 31, 60, 88].map((d) => at(d)), { now: NOW });
    assert.strictEqual(c.kind, 'irregular');
    assert.strictEqual(c.weekday, undefined);
});

test('several events on one day are one occurrence day; perMonth counts them all', () => {
    const ts = days((d) => wd(d) === 1).flatMap((d) => [at(d, 9), at(d, 10), at(d, 11)]);
    const c = cadenceOf(ts, { now: NOW });
    assert.strictEqual(c.kind, 'weekly');
    assert.strictEqual(c.distinctDays, 13);
    assert.strictEqual(c.perMonth, 13);
});

test('perMonth normalises by the history that exists, not the full window', () => {
    const ts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => at(d));
    assert.strictEqual(cadenceOf(ts, { now: NOW, historyDays: 10 }).perMonth, 30);
    assert.strictEqual(cadenceOf(ts, { now: NOW }).perMonth, 3.3);
});

test('events outside the window or in the future are ignored', () => {
    const c = cadenceOf([at(100), at(-2), at(1)], { now: NOW });
    assert.strictEqual(c.distinctDays, 1);
    assert.strictEqual(c.lastTs, at(1));
});

test('empty input is a quiet irregular cadence', () => {
    const c = cadenceOf([], { now: NOW });
    assert.strictEqual(c.kind, 'irregular');
    assert.strictEqual(c.perMonth, 0);
    assert.strictEqual(c.lastTs, null);
});

// ── Local time: the viewer's weekday and hours, not UTC's ──

test('a Monday 00:30 habit in Amsterdam is a Monday habit, not a Sunday-night one', () => {
    // 00:30 CEST (UTC+2, the whole window lies in summer time) is 22:30 UTC the day before.
    const ts = days((d) => wd(d) === 1).map((d) => at(d, 0) - 90 * 60_000);
    const utc = cadenceOf(ts, { now: NOW });
    assert.strictEqual(utc.weekday, 0, 'counted in UTC it looks like Sunday');
    assert.deepStrictEqual(utc.hourBand, [22, 23]);
    const local = cadenceOf(ts, { now: NOW, timeZone: 'Europe/Amsterdam' });
    assert.strictEqual(local.kind, 'weekly');
    assert.strictEqual(local.weekday, 1);
    assert.deepStrictEqual(local.hourBand, [0, 1]);
    assert.strictEqual(local.weekdayHistogram[1], 13);
});

test('a daylight-saving change inside the window moves neither the weekday nor the hour', () => {
    // New York moves to summer time on Sunday 8 March 2026. Every Monday at
    // 09:00 local: 14:00 UTC before the change, 13:00 UTC after it.
    const now = Date.UTC(2026, 3, 30, 18);
    const mondays = [];
    for (let t = Date.UTC(2026, 1, 2); t < now; t += 7 * DAY) mondays.push(t);
    const ts = mondays.map((t) => t + (t < Date.UTC(2026, 2, 8) ? 14 : 13) * 3_600_000);
    const c = cadenceOf(ts, { now, timeZone: 'America/New_York' });
    assert.strictEqual(c.weekday, 1);
    assert.deepStrictEqual(c.hourBand, [9, 10], 'one hour, both sides of the change');
    assert.strictEqual(zoneOffsetMinutes(Date.UTC(2026, 1, 2, 14), 'America/New_York'), -300);
    assert.strictEqual(zoneOffsetMinutes(Date.UTC(2026, 3, 6, 13), 'America/New_York'), -240);
});

test('an unknown zone, or none, counts in UTC', () => {
    assert.strictEqual(isTimeZone('Europe/Amsterdam'), true);
    for (const bad of ['Mars/Olympus_Mons', '', null, undefined, 42, 'x'.repeat(65)]) assert.strictEqual(isTimeZone(bad), false, String(bad));
    const ts = days((d) => wd(d) === 1).map((d) => at(d, 0) - 90 * 60_000);
    assert.strictEqual(cadenceOf(ts, { now: NOW, timeZone: 'Mars/Olympus_Mons' }).weekday, 0);
    assert.strictEqual(cadenceOf(ts, { now: NOW, tzOffsetMinutes: 120 }).weekday, 1, 'a fixed offset still works');
});

test('weeks present never exceed the weeks in the window', () => {
    // History of exactly two weeks: the first event opens a third 7-day bucket.
    const ts = [NOW - 14 * DAY, NOW - 7 * DAY, NOW - DAY];
    const c = cadenceOf(ts, { now: NOW, historyDays: 14 });
    assert.strictEqual(c.weeksWindow, 2);
    assert.strictEqual(c.weeksPresent, 2);
});
