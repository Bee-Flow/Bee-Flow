'use strict';

/**
 * Table caps: defaults, environment overrides, 0 = unlimited, garbage falls back.
 *
 * Run: cd server && node --test core/automationRunner/tables/limits.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { capFromEnv, exceeds, tableLimits } = require('./limits');

test('the defaults', () => {
    assert.deepStrictEqual(tableLimits({}), {
        maxRows: 1_000_000,
        maxBytes: 536_870_912,
        maxColumns: 1000,
        maxFileBytes: 26_214_400,
        maxUncompressedBytes: 268_435_456,
        maxSheets: 50,
        previewRows: 20,
        inlineRows: 200,
        pageMaxRows: 500,
        maxTablesPerRun: 2000,
        maxOps: 50,
        maxGroups: 100_000,
        joinMaxRightRows: 500_000,
        pivotMaxColumns: 200,
        maxSegments: 500,
        minGroupFloor: 10,
        previewInputRows: 1000,
        previewRpm: 60,
        csvRpm: 30,
    });
});

test('an environment variable overrides its default', () => {
    const l = tableLimits({ AUTOMATION_TABLE_MAX_ROWS: '5000', AUTOMATION_TABLE_CSV_RPM: '3', AUTOMATION_TABLE_MIN_GROUP_FLOOR: '25' });
    assert.strictEqual(l.maxRows, 5000);
    assert.strictEqual(l.csvRpm, 3);
    assert.strictEqual(l.minGroupFloor, 25);
    assert.strictEqual(l.maxColumns, 1000);
});

test('0 means unlimited, and for the group floor no floor', () => {
    const l = tableLimits({ AUTOMATION_TABLE_MAX_ROWS: '0', AUTOMATION_TABLE_MIN_GROUP_FLOOR: '0' });
    assert.strictEqual(l.maxRows, 0);
    assert.strictEqual(l.minGroupFloor, 0);
    assert.strictEqual(exceeds(10 ** 12, l.maxRows), false);
});

test('garbage, empty and negative values fall back to the default', () => {
    for (const raw of ['abc', '', '-5', 'NaN', 'Infinity']) {
        assert.strictEqual(capFromEnv('X_CAP', 7, { X_CAP: raw }), 7, raw);
    }
    assert.strictEqual(capFromEnv('X_CAP', 7, {}), 7);
    assert.strictEqual(capFromEnv('X_CAP', 7, { X_CAP: '12.9' }), 12);
});

test('exceeds is true only for an active cap that the value passes', () => {
    assert.strictEqual(exceeds(11, 10), true);
    assert.strictEqual(exceeds(10, 10), false);
    assert.strictEqual(exceeds(11, 0), false);
});

test('the limits are read fresh on every call', () => {
    const before = tableLimits().maxSheets;
    process.env.AUTOMATION_TABLE_MAX_SHEETS = '3';
    try {
        assert.strictEqual(tableLimits().maxSheets, 3);
    } finally {
        delete process.env.AUTOMATION_TABLE_MAX_SHEETS;
    }
    assert.strictEqual(tableLimits().maxSheets, before);
});
