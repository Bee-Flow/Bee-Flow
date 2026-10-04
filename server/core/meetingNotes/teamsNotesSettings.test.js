/**
 * teamsNotesSettings tests — scope detection (bare names and Graph resource
 * URIs), the connection block, and org-over-user resolution with null as
 * "no opinion".
 *
 * Run: cd server && node --test core/meetingNotes/teamsNotesSettings.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const docs = {};
const s = require('./teamsNotesSettings');
s.init({
    configStore: {
        getConfig: async (k) => (k in docs ? docs[k] : null),
        setConfig: async (k, v) => { docs[k] = v; },
    },
});

test('hasTeamsScopes needs recordings AND calendar, in either scope spelling', () => {
    assert.ok(s.hasTeamsScopes('openid Calendars.ReadWrite OnlineMeetingRecording.Read.All'));
    assert.ok(s.hasTeamsScopes('https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/OnlineMeetingRecording.Read.All'));
    assert.ok(s.hasTeamsScopes('calendars.readwrite onlinemeetingrecording.read.all'));
    assert.ok(!s.hasTeamsScopes('Calendars.ReadWrite OnlineMeetings.Read'), 'the old login scopes are not enough');
    assert.ok(!s.hasTeamsScopes(null));
    assert.ok(s.hasMeetingWriteScope('OnlineMeetings.ReadWrite'));
    assert.ok(!s.hasMeetingWriteScope('OnlineMeetings.Read'));
    assert.ok(s.hasTranscriptScope('https://graph.microsoft.com/OnlineMeetingTranscript.Read.All'));
});

test('deriveConnectionStatus: vault credential, live SSO session, needs_reauth', () => {
    const full = 'Calendars.ReadWrite OnlineMeetingRecording.Read.All OnlineMeetings.ReadWrite';
    assert.deepStrictEqual(s.deriveConnectionStatus({ credential: { status: 'active', scope: full } }), {
        microsoftConnected: true, teamsScopesGranted: true, hasMeetingWriteScope: true,
        hasTranscriptScope: false, needsReauth: false,
    });
    const live = s.deriveConnectionStatus({ session: { oauthProvider: 'microsoft', accessToken: 'x', oauthScope: full } });
    assert.strictEqual(live.microsoftConnected, true);
    assert.strictEqual(live.teamsScopesGranted, true);
    const google = s.deriveConnectionStatus({ session: { oauthProvider: 'google', accessToken: 'x', oauthScope: full } });
    assert.strictEqual(google.microsoftConnected, false);
    assert.strictEqual(google.teamsScopesGranted, false, 'a Google session scope never counts');
    const reauth = s.deriveConnectionStatus({ credential: { status: 'needs_reauth', scope: full } });
    assert.strictEqual(reauth.microsoftConnected, false);
    assert.strictEqual(reauth.needsReauth, true);
});

test('resolve: org wins per field, null hands the field back to the user', async () => {
    docs.org_teams_notes_o1 = { autoImport: true, autoRecordConfig: null, language: null, lookbackHours: 500 };
    docs.user_teams_notes_u1 = { autoImport: false, autoRecordConfig: true, language: 'en' };
    assert.deepStrictEqual(await s.resolveTeamsNotesSettings({ orgId: 'o1', userId: 'u1' }), {
        autoImport: true, autoRecordConfig: true, language: 'en', lookbackHours: 168,
    });
    assert.deepStrictEqual(await s.resolveTeamsNotesSettings({ userId: 'nobody' }), {
        autoImport: false, autoRecordConfig: false, language: 'nl', lookbackHours: 24,
    });
});

test('save keeps an explicit null and coerces the rest', async () => {
    const saved = await s.saveOrgSettings('o2', { autoImport: null, autoRecordConfig: 1, lookbackHours: 0 }, 'admin');
    assert.strictEqual(saved.autoImport, null);
    assert.strictEqual(saved.autoRecordConfig, true);
    assert.strictEqual(saved.lookbackHours, 1);
    assert.strictEqual(saved.updatedBy, 'admin');
});
