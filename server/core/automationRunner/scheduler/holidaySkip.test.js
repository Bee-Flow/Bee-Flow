'use strict';

/**
 * The schedule tick's holiday safety net.
 *
 * Run: node --test core/automationRunner/scheduler/holidaySkip.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { holidaySkipFor } = require('./holidaySkip');

const KINGS_DAY_0700 = '2026-04-27T05:00:00.000Z'; // 07:00 Amsterdam
const NOW = Date.parse('2026-04-27T05:00:30Z');

function row(definition, extra = {}) {
    return { id: 'a1', kind: 'automation', definition, version: 3, liveVersion: null, ...extra };
}
const weekday = (schedule) => ({ trigger: { id: 't1', kind: 'schedule', schedule: { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', ...schedule } }, steps: [], edges: [] });

test('a slot on a holiday is skipped and moves to the next working day', () => {
    const out = holidaySkipFor(row(weekday({ skipHolidays: true })), {
        cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', scheduledFor: KINGS_DAY_0700, now: NOW,
    });
    assert.equal(out.holiday.key, 'kings_day');
    assert.equal(out.nextRunAt, '2026-04-28T05:00:00.000Z');
});

test('without the flag the slot runs', () => {
    assert.equal(holidaySkipFor(row(weekday({})), {
        cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', scheduledFor: KINGS_DAY_0700, now: NOW,
    }), null);
});

test('an ordinary day runs', () => {
    assert.equal(holidaySkipFor(row(weekday({ skipHolidays: true })), {
        cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', scheduledFor: '2026-04-28T05:00:00.000Z', now: Date.parse('2026-04-28T05:00:30Z'),
    }), null);
});

test('the flag is read from the LIVE definition, not the working copy', () => {
    const live = weekday({ skipHolidays: true });
    const working = weekday({});
    const a = row(working, { liveVersion: 2 });
    Object.defineProperty(a, 'liveDefinition', { value: live, enumerable: false });
    assert.ok(holidaySkipFor(a, { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', scheduledFor: KINGS_DAY_0700, now: NOW }));

    const b = row(live, { liveVersion: 2 });
    Object.defineProperty(b, 'liveDefinition', { value: working, enumerable: false });
    assert.equal(holidaySkipFor(b, { cron: '0 7 * * 1-5', tz: 'Europe/Amsterdam', scheduledFor: KINGS_DAY_0700, now: NOW }), null,
        'a skipHolidays that is only in the working copy is not live yet');
});

test('an extra schedule trigger is judged by its own flag', () => {
    const def = {
        trigger: { id: 't1', kind: 'manual' },
        triggers: [{ id: 't2', kind: 'schedule', schedule: { cron: '0 7 * * *', skipHolidays: true } }],
        steps: [], edges: [],
    };
    assert.ok(holidaySkipFor(row(def), { triggerStepId: 't2', cron: '0 7 * * *', tz: 'Europe/Amsterdam', scheduledFor: KINGS_DAY_0700, now: NOW }));
    assert.equal(holidaySkipFor(row(def), { triggerStepId: null, cron: '0 7 * * *', tz: 'Europe/Amsterdam', scheduledFor: KINGS_DAY_0700, now: NOW }), null);
});

test('a late pick-up is judged by when the slot was due', () => {
    // Due at 23:30 on 24 December, picked up after midnight on Christmas Day.
    const def = weekday({ skipHolidays: true });
    def.trigger.schedule.cron = '30 23 * * *';
    assert.equal(holidaySkipFor(row(def), {
        cron: '30 23 * * *', tz: 'Europe/Amsterdam', scheduledFor: '2026-12-24T22:30:00.000Z', now: Date.parse('2026-12-24T23:10:00Z'),
    }), null);
});

test('garbage in is "run it", never a throw', () => {
    assert.equal(holidaySkipFor(null, { cron: '0 7 * * *' }), null);
    assert.equal(holidaySkipFor(row(weekday({ skipHolidays: true })), { cron: '' }), null);
    assert.equal(holidaySkipFor(row(weekday({ skipHolidays: true })), { cron: '0 7 * * *', tz: 'Mars/Olympus', scheduledFor: KINGS_DAY_0700 }), null);
});
