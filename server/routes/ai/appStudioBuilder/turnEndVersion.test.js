'use strict';

/**
 * Which row a builder turn leaves at its end (./turnEndVersion.js), as a pure decision. The route
 * writes it (../appStudioBuilder.test.js drives build, follow-up, no-change and failed turns).
 *
 * Run: cd server && node --test routes/ai/appStudioBuilder/turnEndVersion.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { turnStartState, turnEndSummary } = require('./turnEndVersion');

const blank = { screens: [{ id: 's', sections: [{ id: 'x', children: [] }] }] };
const built = { screens: [{ id: 's', sections: [{ id: 'x', children: [{ id: 'c', type: 'heading' }] }] }] };
const more = { screens: [{ id: 's', sections: [{ id: 'x', children: [{ id: 'c', type: 'heading' }, { id: 'd', type: 'text' }] }] }] };
const clean = { lastFinalized: true, persistBroken: false, clientGone: false };
const summary = (start, def, turn = clean, extra = {}) => turnEndSummary(turn, { start: turnStartState(start), def, failed: false, planRan: false, ...extra });

test('a build is a turn that began on an empty app, or ran an approved plan; it is "finished" only when it finalized', () => {
    assert.equal(summary(blank, built), 'AI build finished');
    assert.equal(summary(built, more, clean, { planRan: true }), 'AI build finished');
    assert.equal(summary(blank, built, { ...clean, lastFinalized: false }), 'AI change');
    assert.equal(summary(built, more), 'AI change', 'a follow-up on a built app');
});

test('no row without a change, after an error, a save conflict or a closed tab', () => {
    assert.equal(summary(built, structuredClone(built)), null);
    assert.equal(summary(blank, built, clean, { failed: true }), null);
    assert.equal(summary(blank, built, { ...clean, persistBroken: true }), null);
    assert.equal(summary(blank, built, { ...clean, clientGone: true }), null);
});
