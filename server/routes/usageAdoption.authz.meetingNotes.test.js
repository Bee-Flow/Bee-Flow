'use strict';
/**
 * The Adoption report's summary with the meeting notes module's kind, through
 * the real router chain (./usageAdoption.authz.testkit.js): a recorded meeting
 * makes its recorder a maker.
 *
 * Run: cd server && node --test routes/usageAdoption.authz.meetingNotes.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const r = require('./usageAdoption.authz.testkit');

r.useAdoptionApi();

test('the summary counts the colleague who recorded a meeting as a maker', async () => {
    const res = await r.get('/summary?days=30', r.as('a-owner'));
    const s = res.body;
    assert.equal(s.makers.total, 2, 'owner, and the colleague who recorded a meeting');
});
