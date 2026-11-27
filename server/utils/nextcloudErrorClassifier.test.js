// @typecheck strict
/**
 * utils/nextcloudErrorClassifier.js — raw Nextcloud failures to a stable code.
 *
 * Proven: each code the step-error card builds on is reached from the text the
 * Nextcloud client actually produces, the two handoff-5 splits hold (a WebDAV
 * 403 is NO_ACCESS, not APP_DISABLED; "already exists" is ALREADY_EXISTS, not
 * PARENT_MISSING), and every code maps to an automationErrors class.
 *
 * Run: cd server && node --test utils/nextcloudErrorClassifier.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyNextcloudError, extractHttpStatus } = require('./nextcloudErrorClassifier');

// The raw texts the Nextcloud client produces, with the code each must classify to.
const { cases } = require('./nextcloudErrorClassifier.testkit');

for (const [code, text] of cases) {
    test(`${code} ← ${text.slice(0, 60)}`, () => {
        assert.strictEqual(classifyNextcloudError(text).code, code);
    });
}

test('reads an Error, a { error } result and nothing at all', () => {
    assert.strictEqual(classifyNextcloudError(new Error('File not found: /x')).code, 'NOT_FOUND');
    assert.strictEqual(classifyNextcloudError({ error: 'NOT_CONNECTED' }).code, 'NOT_CONNECTED');
    assert.strictEqual(classifyNextcloudError(null).code, 'UNKNOWN');
});

test('extractHttpStatus reads the client\'s two shapes', () => {
    assert.strictEqual(extractHttpStatus('Nextcloud download failed (409)'), 409);
    assert.strictEqual(extractHttpStatus('request failed: 503'), 503);
    assert.strictEqual(extractHttpStatus('no status here'), null);
});

test('the Nextcloud tools\' own 403 and 404 wording is not taken for a connector outage', () => {
    const denied = classifyNextcloudError('Permission denied for Teams update: Only the owner may do this.');
    assert.notStrictEqual(denied.code, 'CONNECTOR_UNREACHABLE');
    assert.strictEqual(denied.category, 'permission');
    const missing = classifyNextcloudError('Not found for Forms form fetch: the id may be wrong, or the "Forms" app is not installed or enabled.');
    assert.strictEqual(missing.code, 'NOT_FOUND');
});

test('"no access" is app-aware: Files text only for file tools, the app name for the rest', () => {
    const families = {
        nextcloud_teams_get: 'Teams', nextcloud_mail_read: 'Mail', nextcloud_tasks_create: 'Tasks',
        nextcloud_deck_get_board: 'Deck', nextcloud_talk_send_message: 'Talk', nextcloud_notes_get: 'Notes',
        nextcloud_calendar_list: 'Calendar', nextcloud_contacts_get: 'Contacts', nextcloud_tables_list: 'Tables',
        nextcloud_forms_get: 'Forms',
    };
    for (const [tool, app] of Object.entries(families)) {
        const c = classifyNextcloudError('Permission denied for something: not yours', { tool });
        assert.strictEqual(c.code, 'NO_ACCESS', tool);
        assert.strictEqual(c.message, `This account may not do this in Nextcloud ${app}.`, tool);
        assert.doesNotMatch(`${c.message} ${c.remediation}`, /file or folder|Share the folder/i, tool);
    }
    for (const tool of ['nextcloud_upload_file', 'nextcloud_read_file', 'nextcloud_list_files', 'nextcloud_move', 'nextcloud_share_with_user', undefined]) {
        const c = classifyNextcloudError('Permission denied for read of /A/b.txt', { tool });
        assert.match(c.message, /file or folder/, String(tool));
        assert.match(c.remediation, /Share the folder/, String(tool));
        assert.match(c.remediation, /read-only share, a team folder permission or a file access control rule/, String(tool));
    }
});

test('a 503 is a rate limit only when the answer says so; maintenance and unavailable are transient, a lock and a full quota are not', () => {
    const maintenance = classifyNextcloudError('Nextcloud is in maintenance mode (503) during x.');
    assert.strictEqual(maintenance.errorClass, 'TransientError');
    assert.doesNotMatch(`${maintenance.message} ${maintenance.remediation}`, /rate/i);
    const unavailable = classifyNextcloudError('Nextcloud download failed (503)');
    assert.strictEqual(unavailable.message, 'Nextcloud is temporarily unavailable.');
    assert.strictEqual(unavailable.errorClass, 'TransientError');
    assert.strictEqual(classifyNextcloudError('request failed: 429').message, 'Nextcloud is rate-limiting requests.');
    for (const text of ['Delete failed (423)', 'Upload failed (507): Insufficient storage']) {
        const c = classifyNextcloudError(text);
        assert.strictEqual(c.category, 'precondition', text);
        assert.strictEqual(c.errorClass, 'IntegrationError', text);
    }
});

test('"locked" and "quota" from another app are not a file lock or a full quota', () => {
    assert.notStrictEqual(classifyNextcloudError('This Talk room is locked', { tool: 'nextcloud_talk_send_message' }).code, 'FILE_LOCKED');
    assert.notStrictEqual(classifyNextcloudError('Mail quota exceeded for the account', { tool: 'nextcloud_mail_send' }).code, 'QUOTA_EXCEEDED');
    assert.strictEqual(classifyNextcloudError('"a.docx" is locked', { tool: 'nextcloud_delete' }).code, 'FILE_LOCKED');
});

// That every code carries an automationErrors class, and that the automation runner passes the
// tool name, are the automation module's: nextcloudErrorClassifier.automation.test.js.

test('nextcloud_list_groups and nextcloud_search are not worded as Files', () => {
    const { nextcloudAppOf } = require('./nextcloudErrorClassifier');
    assert.strictEqual(nextcloudAppOf('nextcloud_list_groups'), 'Groups');
    assert.strictEqual(nextcloudAppOf('nextcloud_search'), 'Search');
    assert.strictEqual(nextcloudAppOf('nextcloud_list_files'), 'Files');
    assert.strictEqual(nextcloudAppOf('nextcloud_search_files'), 'Files');
});
