// @typecheck strict
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { matchNextcloudTablesRowFilter, matchNextcloudCalendarFilter } = require('./filters');

const row = { tableId: 1, values: { 10: 'open', 11: 'High priority' }, previousValues: { 10: 'open', 11: 'Low' } };

test('tables.row: a value filter without columnId holds when any column satisfies it', () => {
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { valueEquals: 'open' }), true);
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { valueEquals: 'closed' }), false);
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { valueContains: 'priority' }), true);
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { valueContains: 'nothing' }), false);
});

test('tables.row: changedOnly without columnId needs at least one changed column', () => {
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { changedOnly: true }), true);
    const same = { values: { 10: 'a' }, previousValues: { 10: 'a' } };
    assert.strictEqual(matchNextcloudTablesRowFilter(same, { changedOnly: true }), false);
});

test('tables.row: with columnId the behaviour is unchanged', () => {
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { columnId: 10, valueEquals: 'open' }), true);
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { columnId: 11, valueEquals: 'open' }), false);
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { columnId: 10, changedOnly: true }), false);
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { columnId: 11, changedOnly: true }), true);
});

test('calendar: calendarId matches the webhook numeric id and the poller URI form', () => {
    const p = { calendarId: 4, calendarUri: 'personal' };
    assert.strictEqual(matchNextcloudCalendarFilter(p, { calendarId: '4' }), true);
    assert.strictEqual(matchNextcloudCalendarFilter(p, { calendarId: 'personal' }), true);
    assert.strictEqual(matchNextcloudCalendarFilter(p, { calendarUri: 'personal' }), true);
    assert.strictEqual(matchNextcloudCalendarFilter(p, { calendarId: 'work' }), false);
    assert.strictEqual(matchNextcloudCalendarFilter(p, { calendarUri: 'work' }), false);
});

test('tables.row: null / empty value filters are unset; changedOnly without previousValues passes', () => {
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { valueEquals: null, valueContains: '' }), true);
    assert.strictEqual(matchNextcloudTablesRowFilter(row, { valueEquals: '' }), true);
    assert.strictEqual(matchNextcloudTablesRowFilter({ values: { 10: 'a' } }, { changedOnly: true }), true);
    assert.strictEqual(matchNextcloudTablesRowFilter({ tableId: 1 }, { changedOnly: true }), true);
});

// ── #193: every filter, fed by each producer's canonical payload ─────────
const { matchNextcloudFileFilter, matchNextcloudTagFilter, tagFilterNeedsNames } = require('./filters');
const { normaliseNextcloudPayload } = require('./ncPayload.mts');
const { _ncNormaliseActivity } = require('./pollers/nextcloud');

const PRODUCERS = {
    // nextcloud-connector automationEventsWebhook.normalisePayload output
    webhook: normaliseNextcloudPayload('file.new', { id: 437, path: '/Invoices/2026/x.PDF', name: 'x.PDF', extension: 'pdf', kind: 'file', owner: 'alice', actor: 'alice', actorName: 'Alice', datetime: '2026-10-28T09:00:00Z', link: null, isOwnAction: true }),
    poller: normaliseNextcloudPayload('file.new', _ncNormaliseActivity({ id: 9, type: 'file_created', subject: 'created', actor: 'alice', objectId: 437, objectName: '/Invoices/2026/x.PDF' }, { nextcloudUid: 'alice' })),
};

for (const [producer, p] of Object.entries(PRODUCERS)) {
    test(`file filters (${producer}): inFolder, extension, nameContains, excludeOwnUploads`, () => {
        assert.strictEqual(matchNextcloudFileFilter(p, { inFolder: '/Invoices' }), true);
        assert.strictEqual(matchNextcloudFileFilter(p, { inFolder: 'Invoices/2026/' }), true);
        assert.strictEqual(matchNextcloudFileFilter(p, { inFolder: '/Inv' }), false);
        assert.strictEqual(matchNextcloudFileFilter(p, { extension: '.pdf' }), true);
        assert.strictEqual(matchNextcloudFileFilter(p, { extension: 'docx' }), false);
        assert.strictEqual(matchNextcloudFileFilter(p, { nameContains: 'X.p' }), true);
        assert.strictEqual(matchNextcloudFileFilter(p, { excludeOwnUploads: true }), false, 'alice\'s own upload');
        assert.strictEqual(matchNextcloudFileFilter({ ...p, isOwnAction: false }, { excludeOwnUploads: true }), true);
    });
}

test('tag filter: tagId as a number, as a numeric string or as a name (resolved names, case-insensitive)', () => {
    const p = { tagIds: [3, 17], tagId: 3, tagNames: ['Invoice', 'Paid'] };
    assert.strictEqual(matchNextcloudTagFilter(p, { tagId: 17 }), true);
    assert.strictEqual(matchNextcloudTagFilter(p, { tagId: '3' }), true);
    assert.strictEqual(matchNextcloudTagFilter(p, { tagId: 4 }), false);
    assert.strictEqual(matchNextcloudTagFilter(p, { tagId: 'invoice' }), true);
    assert.strictEqual(matchNextcloudTagFilter(p, { tagId: 'Archive' }), false);
    assert.strictEqual(matchNextcloudTagFilter(p, { tagName: 'PAID' }), true);
    // No names looked up (no lookup possible): a name never matches by accident.
    assert.strictEqual(matchNextcloudTagFilter({ tagIds: [3] }, { tagId: 'Invoice' }), false);
    // The legacy activity shape with its own tagName still works.
    assert.strictEqual(matchNextcloudTagFilter({ tagName: 'Invoice' }, { tagName: 'Invoice' }), true);
});

test('tag filter: the dispatcher looks names up only when a filter names one', () => {
    assert.strictEqual(tagFilterNeedsNames({ tagId: 3 }), false);
    assert.strictEqual(tagFilterNeedsNames({ tagId: '3' }), false);
    assert.strictEqual(tagFilterNeedsNames({ tagId: 'Invoice' }), true);
    assert.strictEqual(tagFilterNeedsNames({ tagName: 'Invoice' }), true);
    assert.strictEqual(tagFilterNeedsNames({ any: [{ tagId: 3 }, { tagId: 'Paid' }] }), true);
    assert.strictEqual(tagFilterNeedsNames(null), false);
});

test('calendar filters on each producer\'s canonical payload', () => {
    const pushed = normaliseNextcloudPayload('calendar.event.created', { calendarId: 4, calendarUri: 'work', uid: 'a' });
    const polled = normaliseNextcloudPayload('calendar.event.upcoming', { calendarId: 'work', calendar: 'work', uid: 'a', summary: 'Kickoff' });
    for (const p of [pushed, polled]) {
        assert.strictEqual(matchNextcloudCalendarFilter(p, { calendarId: 'work' }), true);
        assert.strictEqual(matchNextcloudCalendarFilter(p, { calendarUri: 'work' }), true);
        assert.strictEqual(matchNextcloudCalendarFilter(p, { calendarUri: 'personal' }), false);
    }
    assert.strictEqual(matchNextcloudCalendarFilter(pushed, { calendarId: 4 }), true);
    assert.strictEqual(matchNextcloudCalendarFilter(polled, { summaryContains: 'kick' }), true);
});
