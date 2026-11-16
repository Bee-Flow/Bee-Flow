'use strict';

/**
 * The plan artifact of app_propose_plan (planTools.js): a redesign plan keeps each screen's
 * regrouping (`moves`) and what an attached picture showed (`imageNotes`), capped like the rest.
 *
 * Run: cd server && node --test appStudio/builderTools/planTools.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { boundPlanArtifact } = require('./planTools');

test('screen moves keep complete { from, to } pairs, capped; junk is dropped', () => {
    const { plan } = boundPlanArtifact({
        title: 'Tidy the home screen',
        screens: [{
            name: 'Home', purpose: 'Overview', contents: ['List'],
            moves: [
                { from: 'Search and three filters, loose at the top', to: 'One Filters card above the list' },
                { from: 'only a from' },
                'not an object',
                { from: 'x'.repeat(500), to: 'Right column' },
                ...Array.from({ length: 30 }, (_, i) => ({ from: `a${i}`, to: `b${i}` })),
            ],
        }, { name: 'Other', purpose: 'p', contents: [], moves: [{ to: 'nowhere' }] }],
    });
    const [home, other] = plan.screens;
    assert.deepEqual(home.moves[0], { from: 'Search and three filters, loose at the top', to: 'One Filters card above the list' });
    assert.equal(home.moves[1].from.length, 160);
    assert.ok(home.moves.length <= 20);
    assert.equal('moves' in other, false);
});

test('imageNotes is kept, capped at 400 characters, and absent when empty', () => {
    assert.equal(boundPlanArtifact({ title: 'T', imageNotes: 'n'.repeat(900) }).plan.imageNotes.length, 400);
    assert.equal('imageNotes' in boundPlanArtifact({ title: 'T', imageNotes: '  ' }).plan, false);
});
