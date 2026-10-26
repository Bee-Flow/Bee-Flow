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
