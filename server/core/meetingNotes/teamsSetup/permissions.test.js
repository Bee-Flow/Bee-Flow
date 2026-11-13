'use strict';
/**
 * The permission catalogue of the Teams setup screens: one delegated row per
 * scope the connect flow requests, in its order, with the admin-consent column
 * of Microsoft's permissions reference; four application rows for option B.
 *
 * Run: cd server && node --test core/meetingNotes/teamsSetup/permissions.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const perms = require('./permissions.mts');
const { MICROSOFT_SCOPES } = require('../../../auth/permissionsOAuth');

test('the delegated list is exactly the sign-in scopes plus the connect extras, which are what the connect flow asks for', () => {
    const names = perms.delegatedPermissions().map((p) => p.name);
    assert.deepEqual(names, [...MICROSOFT_SCOPES, ...perms.CONNECT_EXTRA_SCOPES]);
    // routes/integrations/microsoft365.test.js pins that the connect flow's
    // MS_CONNECT_SCOPES is built from the same two lists.
    assert.deepEqual(perms.CONNECT_EXTRA_SCOPES, ['Mail.Read.Shared', 'Mail.Send.Shared', 'Mail.ReadWrite', 'Mail.ReadWrite.Shared']);
});

test('every requested scope is described (none falls back to the undescribed default)', () => {
    for (const name of perms.requestedDelegatedScopes()) {
        assert.ok(perms.isDescribedScope(name), `${name} has no row in permissions.mts or teamsNotesSettings.js`);
    }
});

test('the Teams rows: required calendar and recordings, optional transcripts and auto-record, admin consent for the .All ones', () => {
    const byName = new Map(perms.delegatedPermissions().map((p) => [p.name, p]));
    const pick = (n) => { const p = byName.get(n); return { role: p.role, adminConsent: p.adminConsent, purpose: p.purpose }; };
    assert.deepEqual(pick('Calendars.ReadWrite'), { role: 'required', adminConsent: false, purpose: 'calendar' });
    assert.deepEqual(pick('OnlineMeetingRecording.Read.All'), { role: 'required', adminConsent: true, purpose: 'recordings' });
    assert.deepEqual(pick('OnlineMeetingTranscript.Read.All'), { role: 'optional', adminConsent: true, purpose: 'transcripts' });
    assert.deepEqual(pick('OnlineMeetings.ReadWrite'), { role: 'optional', adminConsent: false, purpose: 'auto_record' });
    assert.equal(byName.has('OnlineMeetingArtifact.Read.All'), false, 'not asked for: nothing reads meeting artifacts');
    assert.deepEqual(pick('Mail.ReadWrite.Shared'), { role: 'requested', adminConsent: false, purpose: 'shared_mailbox' });
    assert.deepEqual(pick('offline_access'), { role: 'requested', adminConsent: false, purpose: 'offline' });
    for (const p of perms.delegatedPermissions()) {
        assert.equal(p.kind, 'delegated');
        assert.equal(p.option, 'A');
    }
});

test('the application rows of option B all need admin consent', () => {
    const rows = perms.applicationPermissions();
    assert.deepEqual(rows.map((r) => [r.name, r.role, r.purpose]), [
        ['OnlineMeetings.Read.All', 'required', 'meetings'],
        ['OnlineMeetingRecording.Read.All', 'required', 'recordings'],
        ['Calendars.Read', 'required', 'calendar'],
        ['OnlineMeetingTranscript.Read.All', 'optional', 'transcripts'],
    ]);
    for (const r of rows) {
        assert.equal(r.kind, 'application');
        assert.equal(r.option, 'B');
        assert.equal(r.adminConsent, true);
    }
    rows[0].name = 'changed';
    assert.equal(perms.applicationPermissions()[0].name, 'OnlineMeetings.Read.All', 'callers get copies');
});
