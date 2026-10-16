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
const { ALL_CODES } = require('../core/automationErrors');

const cases = [
    ['NOT_CONNECTED', 'NOT_CONNECTED'],
    ['NOT_CONNECTED', 'Nextcloud not connected. Log in via Nextcloud OAuth, or add your username and app password in Settings → Connections.'],
    ['SESSION_EXPIRED', 'Nextcloud token refresh failed — user must re-authenticate'],
    ['SESSION_EXPIRED', 'Nextcloud download failed (401)'],
    ['CONNECTOR_UNREACHABLE', 'Could not reach Nextcloud through the ExApp'],
    ['THROTTLED', 'Nextcloud PROPFIND failed (429): Too Many Requests'],
    ['TIMEOUT', 'The request timed out'],
    ['ALREADY_EXISTS', 'Folder already exists: /Invoices'],
    ['PARENT_MISSING', 'Parent folder for /Invoices/2026/a.pdf does not exist. Create it first with nextcloud_create_folder.'],
    ['NO_ACCESS', 'Nextcloud PROPFIND failed (403): <s:exception>Sabre\\DAV\\Exception\\Forbidden</s:exception>'],
    ['NO_ACCESS', 'Upload failed (403): forbidden'],
    ['NO_ACCESS', 'Permission denied on /HR'],
    ['APP_DISABLED', 'Deck request failed (403)'],
    ['APP_DISABLED', 'The Notes app is not enabled for this user'],
    ['NOT_FOUND', 'File not found: /Invoices/missing.pdf'],
    ['NOT_FOUND', 'Folder not found: /Nope'],
    ['MISSING_FIELD', 'path is required'],
    ['UNKNOWN', 'Something odd happened'],
];

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

test('every code carries an errorClass the run-facets dashboard knows', () => {
    for (const [, text] of cases) {
        const c = classifyNextcloudError(text);
        assert.ok(ALL_CODES.includes(c.errorClass), `${c.code} → ${c.errorClass}`);
        assert.ok(c.message && c.remediation);
    }
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
    }
});

test('the runner passes the tool name: a non-Files permission error is worded for its own app', () => {
    const { enrichNextcloudError } = require('../core/automationRunner/shared');
    const e = enrichNextcloudError('nextcloud_teams_get', new Error('Permission denied for Teams fetch'));
    assert.match(e.message, /Nextcloud Teams/);
    assert.doesNotMatch(e.message, /file or folder|Share the folder/);
});
