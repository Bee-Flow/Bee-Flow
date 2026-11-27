// @typecheck strict
/**
 * The automation module's half of nextcloudErrorClassifier.test.js: every code the classifier
 * gives carries an errorClass the run-facets dashboard knows (core/automationErrors), and the
 * automation runner passes the tool name, so a non-Files permission error is worded for its app.
 *
 * Run: cd server && node --test utils/nextcloudErrorClassifier.automation.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyNextcloudError } = require('./nextcloudErrorClassifier');
const { ALL_CODES } = require('../core/automationErrors');
const { cases } = require('./nextcloudErrorClassifier.testkit');

test('every code carries an errorClass the run-facets dashboard knows', () => {
    for (const [, text] of cases) {
        const c = classifyNextcloudError(text);
        assert.ok(ALL_CODES.includes(c.errorClass), `${c.code} → ${c.errorClass}`);
        assert.ok(c.message && c.remediation);
    }
});

test('the runner passes the tool name: a non-Files permission error is worded for its own app', () => {
    const { enrichNextcloudError } = require('../core/automationRunner/shared');
    const e = enrichNextcloudError('nextcloud_teams_get', new Error('Permission denied for Teams fetch'));
    assert.match(e.message, /Nextcloud Teams/);
    assert.doesNotMatch(e.message, /file or folder|Share the folder/);
});
