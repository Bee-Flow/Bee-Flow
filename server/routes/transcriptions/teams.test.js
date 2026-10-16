/**
 * Route tests for routes/transcriptions/teams.js: the status of an upcoming
 * meeting in GET /teams-meetings and the recording state in GET /teams-recordings.
 * Collaborators are injected through router.init(); no database, no Graph.
 *
 * Run: cd server && node --test routes/transcriptions/teams.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const router = require('./teams');

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const fx = {};
function reset() {
    fx.settings = { autoImport: false, autoRecordConfig: false };
    fx.upcoming = [];
    fx.ended = [];
    fx.prefs = {};
    fx.meeting = { id: 'M1' };
    fx.artifact = null;
    fx.job = null;
}
reset();

router.init({
    permissions: { requireAuth: (_req, _res, next) => next() },
    shared: { resolveUserOrgFromReq: async () => 'orgA', resolveAccessContext: async () => ({}) },
    settings: {
        resolveTeamsNotesSettings: async () => fx.settings,
        deriveConnectionStatus: () => ({ teamsScopesGranted: true, hasTranscriptScope: true }),
    },
    calendar: {
        listUpcomingTeamsMeetings: async () => fx.upcoming,
        listRecentlyEndedTeamsMeetings: async () => fx.ended,
    },
    artifacts: { getOnlineMeetingByJoinUrl: async () => fx.meeting },
    autoImport: { findArtifact: async () => fx.artifact },
    importStore: { getJobForEvent: async () => fx.job },
    meetingPrefs: {
        teamsIds: ({ eventId }) => [{ kind: 'event', id: eventId }],
        participantCountOf: () => 5,
        loadMeetingPrefs: async () => ({
            tagsFor: () => [],
            decide: ({ ids, fallback }) => {
                const o = fx.prefs[ids[0].id];
                if (o === true) return { record: true, reason: 'opted_in' };
                if (o === false) return { record: false, reason: 'opted_out' };
                return fallback ? { record: true, reason: 'auto' } : { record: false, reason: 'auto_off' };
            },
        }),
    },
    credentialStore: { getCredential: async () => ({}) },
    resolveMicrosoftSession: async () => ({ accessToken: 'at' }),
});

let server;
let baseUrl;
test.before(async () => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { id: 'u1' } }; next(); });
    app.use('/api/transcriptions', router);
    app.use(require('../../core/http/terminalErrorHandler').terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); });
test.beforeEach(reset);

const getJson = async (p) => (await fetch(`${baseUrl}/api/transcriptions${p}`)).json();
const upcoming = (over = {}) => ({ eventId: 'e1', seriesMasterId: null, title: 'Overleg', organizerSelf: true, ...over });
const ended = (over = {}) => ({ eventId: 'e1', title: 'Overleg', joinUrl: 'https://teams.microsoft.com/l/x', organizerSelf: true, start: hoursAgo(2), end: hoursAgo(1), ...over });

test('teams-meetings: autoImport off, a record mark makes the meeting will_import', async () => {
    fx.upcoming = [upcoming({ eventId: 'e1' }), upcoming({ eventId: 'e2' })];
    fx.prefs.e1 = true;
    const out = await getJson('/teams-meetings');
    assert.deepStrictEqual(out.meetings.map(m => m.status), ['will_import', 'upcoming']);
});

test('teams-meetings: an opt-out stays excluded', async () => {
    fx.settings.autoImport = true;
    fx.upcoming = [upcoming()];
    fx.prefs.e1 = false;
    assert.strictEqual((await getJson('/teams-meetings')).meetings[0].status, 'excluded');
});
