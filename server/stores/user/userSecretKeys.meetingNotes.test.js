// @typecheck
/**
 * The per-user config stems name the Teams auto-import skip state of module "meetingNotes" as
 * that module spells it. Moved out of userSecretKeys.test.js unchanged: it needs the module's file.
 *
 * Run: cd server && node --test stores/user/userSecretKeys.meetingNotes.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { perUserConfigStems } = require('./userSecretKeys.mts');

test('erasure covers the Teams auto-import skip state', () => {
    const { SKIP_STATE_STEM, skipStateKey } = require('../../core/meetingNotes/teamsImportSkipState.mts');
    assert.ok(perUserConfigStems().includes(SKIP_STATE_STEM));
    assert.equal(skipStateKey('u1'), `${SKIP_STATE_STEM}_user_u1`, 'the key has the <stem>_user_<id> shape erasure deletes');
});
