// @typecheck strict
/**
 * What the English strings promise about the "Meeting note ready" trigger,
 * pinned to what the trigger does.
 *
 * The trigger is OWNER-ONLY: `emitMeetingProcessed` always passes the note
 * owner's userId, dispatch runs only that person's subscriptions, and the
 * declaration says `scope: 'user'`. The Learning Center lesson used to teach
 * the opposite ("fires across the whole organisation, so a colleague's
 * automation picks Sandra's note up too"), and the exercise rubric rewarded
 * learners for repeating it.
 *
 * Pure: reads the merged English dictionary, the trigger declaration and the
 * learning catalog.
 *
 * Run: cd server && node --test i18n/defaults/en.meeting-trigger-scope.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { GUI_DEFAULTS } = require('./en');
const { TRIGGER_SOURCES } = require('../../automation/triggerSources/declared/meeting-notes');
const { RUBRICS } = require('../../learning/catalog.generated');

/** @param {string} key */
function s(key) {
    const value = GUI_DEFAULTS[key];
    assert.equal(typeof value, 'string', `${key} is in the dictionary`);
    return value;
}

const ORG_WIDE = /whole organisation|organisation-wide|across the organisation|colleague's automation[^.]*picks/i;

test('the trigger declaration is owner-only, which is what the strings below describe', () => {
    assert.equal(TRIGGER_SOURCES[0].events[0].scope, 'user');
});

test('the lesson does not tell learners a colleague\'s automation picks their note up', () => {
    const pickup = s('learn.meetings-actions-and-sharing.pickup.body');
    const automationLine = pickup.split('\n').find(l => l.includes('Meeting note ready'));
    assert.ok(automationLine, 'the pickup slide still explains the automation trigger');
    assert.doesNotMatch(automationLine, ORG_WIDE);
    assert.match(automationLine, /your own/);

    const recapTag = s('learn.meetings-actions-and-sharing.recap.body').split('\n').find(l => l.includes('Tag with intent'));
    assert.ok(recapTag);
    assert.doesNotMatch(recapTag, /it reaches across the organisation/);
    assert.match(recapTag, /only on your own notes/);

    assert.doesNotMatch(s('learn.meetings-actions-and-sharing.share-call.placeholder'), /account managers' automation watches/);
});

test('the builder hint for an empty tag filter says whose notes it runs on', () => {
    assert.match(s('meetings.trigger_tags_empty_means_all'), /EVERY finished meeting note of yours/);
});

test('the exercise rubric does not reward the claim that the trigger is organisation-wide', () => {
    const rubric = RUBRICS?.['ex-meetings-actions-and-sharing-ticket'];
    assert.ok(rubric, 'the rubric exists');
    for (const c of rubric.criteria) assert.doesNotMatch(c, /trigger is organisation-wide/);
});
