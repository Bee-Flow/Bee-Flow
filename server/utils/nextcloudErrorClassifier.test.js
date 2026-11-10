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
const { ALL_CODES } = require('../core/automationErrors');

const cases = [
    ['NOT_CONNECTED', 'NOT_CONNECTED'],
    ['NOT_CONNECTED', 'Nextcloud not connected. Log in via Nextcloud OAuth, or add your username and app password in Settings → Connections.'],
    ['SESSION_EXPIRED', 'Nextcloud token refresh failed — user must re-authenticate'],
    ['SESSION_EXPIRED', 'Nextcloud download failed (401)'],
    ['CONNECTOR_UNREACHABLE', 'Could not reach Nextcloud through the ExApp'],
    ['THROTTLED', 'Nextcloud PROPFIND failed (429): Too Many Requests'],
    ['THROTTLED', 'Deck request failed (503): rate limit reached'],
    ['NEXTCLOUD_MAINTENANCE', 'Nextcloud is in maintenance mode (503) during board list. Try again when the maintenance or upgrade is finished.'],
    ['NEXTCLOUD_MAINTENANCE', 'Nextcloud PROPFIND failed (503): <s:exception>OCA\\DAV\\Connector\\Sabre\\Exception\\ServerMaintenanceMode</s:exception><s:message>System is in maintenance mode.</s:message>'],
    ['TEMPORARILY_UNAVAILABLE', 'Nextcloud download failed (503)'],
    ['TEMPORARILY_UNAVAILABLE', 'Nextcloud could not be reached or is temporarily unavailable (503) during team lookup. Try again shortly.'],
    ['PROXY_ANSWERED', 'A proxy in front of Nextcloud answered instead of Nextcloud (403) during team list: it blocked the request (a firewall or bot rule). Ask the Nextcloud admin to let the Bee Flow calls through.'],
    ['PROXY_ANSWERED', 'A proxy in front of Nextcloud answered instead of Nextcloud (522) during download: the proxy got no answer from Nextcloud. Check that Nextcloud is up and reachable from the proxy.'],
    ['FILE_LOCKED', '/Docs/report.docx is locked in Nextcloud (423): it is open in an editor or locked by another user. Try again later, or ask them to unlock it.'],
    ['FILE_LOCKED', 'MOVE failed (423): <s:exception>OCA\\DAV\\Connector\\Sabre\\Exception\\FileLocked</s:exception><s:message>"a.docx" is locked</s:message>'],
    ['FILE_LOCKED', 'Delete failed (423)'],
    ['FILE_LOCKED', 'Could not write the file: "a.docx" is locked'],
    ['QUOTA_EXCEEDED', 'Not enough storage in Nextcloud for /Docs/big.zip (507): the quota of the account or the folder is used up.'],
    ['QUOTA_EXCEEDED', 'Upload failed (507): <s:exception>Sabre\\DAV\\Exception\\InsufficientStorage</s:exception><s:message>Insufficient space in /Docs</s:message>'],
    ['QUOTA_EXCEEDED', 'Upload of the file stopped: Insufficient storage'],
    ['NO_ACCESS', 'Permission denied in Nextcloud for /HR/a.pdf (403): the account may not change this file or folder. A read-only share, a team folder permission or a file access control rule can block it.'],
    ['NO_ACCESS', 'Upload failed (403): <s:exception>Sabre\\DAV\\Exception\\Forbidden</s:exception><s:message>Access denied by a file access control rule</s:message>'],
    ['NOT_FOUND', 'File not found: /Invoices/507/a.pdf'],
    ['NOT_FOUND', 'File not found: /Rooms/423/plan.pdf'],
    ['NO_ACCESS', 'Upload failed (403): the folder is locked down, quota exceeded elsewhere'],
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

test('the runner passes the tool name: a non-Files permission error is worded for its own app', () => {
    const { enrichNextcloudError } = require('../core/automationRunner/shared');
    const e = enrichNextcloudError('nextcloud_teams_get', new Error('Permission denied for Teams fetch'));
    assert.match(e.message, /Nextcloud Teams/);
    assert.doesNotMatch(e.message, /file or folder|Share the folder/);
});

test('nextcloud_list_groups and nextcloud_search are not worded as Files', () => {
    const { nextcloudAppOf } = require('./nextcloudErrorClassifier');
    assert.strictEqual(nextcloudAppOf('nextcloud_list_groups'), 'Groups');
    assert.strictEqual(nextcloudAppOf('nextcloud_search'), 'Search');
    assert.strictEqual(nextcloudAppOf('nextcloud_list_files'), 'Files');
    assert.strictEqual(nextcloudAppOf('nextcloud_search_files'), 'Files');
});
