'use strict';

/**
 * The management-review agenda names the LAST closed internal audit. The
 * stamps are Date objects; sorting them as text picked the one whose weekday
 * name sorts last ("Wed" over "Mon"), not the latest one.
 *
 * Run: cd server && node --test routes/compliance/isoProcess.lastAudit.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { latestOf } = require('./shared');

test('the latest closed audit is the latest instant, whatever its weekday', () => {
    const wednesday = new Date('2026-10-28T10:00:00Z');   // older
    const monday = new Date('2026-11-02T10:00:00Z');      // newer
    assert.strictEqual(latestOf([wednesday, monday]), monday);
    assert.strictEqual(latestOf([monday, null, wednesday]), monday);
    assert.strictEqual(latestOf([]), null);
    assert.strictEqual(latestOf([null]), null);
});
