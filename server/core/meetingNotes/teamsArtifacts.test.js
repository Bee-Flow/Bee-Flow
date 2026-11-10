/**
 * teamsArtifacts + teamsCalendar tests — Graph lookups, occurrence matching,
 * the streamed download cap, VTT parsing, the failure classification that
 * tells "admin switched transcript API access off" apart from a plain refusal
 * (nested innerError codes included), and the `/me` or `/users/<id>` seam.
 *
 * Graph is injected through each module's init() as `graphRequest`/`graphFetch`
 * stubs that answer with real fetch Responses.
 *
 * Run: cd server && node --test core/meetingNotes/teamsArtifacts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fx = { calls: [], handler: null };
const GRAPH_MOCK = {
    graphRequest: async (p, session, options = {}) => {
        fx.calls.push({ path: p, options });
        return fx.handler(p, options);
    },
    graphFetch: async (p, session, options = {}) => {
        fx.calls.push({ path: p, options });
        const res = await fx.handler(p, options);
        return res.json();
    },
};
const artifacts = require('./teamsArtifacts');
const calendar = require('./teamsCalendar');

artifacts.init({ graphRequest: GRAPH_MOCK.graphRequest });
calendar.init({ graphFetch: GRAPH_MOCK.graphFetch });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const graphError = (status, code, message = '') => json({ error: { code, message } }, status);
const session = { accessToken: 'at' };

test.beforeEach(() => { fx.calls = []; fx.handler = null; });

// ── calendar ─────────────────────────────────────────────────────────

test('isTeamsJoinUrl accepts work and personal Teams links only', () => {
    assert.ok(calendar.isTeamsJoinUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x'));
    assert.ok(calendar.isTeamsJoinUrl('https://teams.live.com/meet/9312345'));
    assert.ok(!calendar.isTeamsJoinUrl('https://meet.google.com/abc-defg-hij'));
    assert.ok(!calendar.isTeamsJoinUrl('https://evil.example/teams.microsoft.com/'));
    assert.ok(!calendar.isTeamsJoinUrl(null));
});

test('formatTeamsEvent turns UTC wall time into instants and drops non-Teams/cancelled events', () => {
    const base = {
        id: 'ev1', subject: 'Weekly', isOrganizer: true, seriesMasterId: 'sm1',
        start: { dateTime: '2026-10-01T09:00:00.0000000' }, end: { dateTime: '2026-10-01T09:30:00.0000000' },
        organizer: { emailAddress: { address: 'tom@example.nl' } },
        attendees: [{ emailAddress: { address: 'a@example.nl', name: 'An' } }],
        onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' },
    };
    const m = calendar.formatTeamsEvent(base);
    assert.strictEqual(m.start, '2026-10-01T09:00:00.000Z');
    assert.strictEqual(m.end, '2026-10-01T09:30:00.000Z');
    assert.strictEqual(m.organizerSelf, true);
    assert.strictEqual(m.seriesMasterId, 'sm1');
    assert.deepStrictEqual(m.attendees, [{ email: 'a@example.nl', displayName: 'An' }]);
    assert.strictEqual(calendar.formatTeamsEvent({ ...base, isCancelled: true }), null);
    assert.strictEqual(calendar.formatTeamsEvent({ ...base, onlineMeeting: { joinUrl: 'https://zoom.us/j/1' } }), null);
});

test('listUpcomingTeamsMeetings pins UTC and follows nextLink', async () => {
    let page = 0;
    fx.handler = () => {
        page += 1;
        return json(page === 1
            ? { value: [{ id: 'a', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/a' }, start: {}, end: {} }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' }
            : { value: [{ id: 'b', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/b' }, start: {}, end: {} }] });
    };
    const out = await calendar.listUpcomingTeamsMeetings({ session });
    assert.deepStrictEqual(out.map(m => m.eventId), ['a', 'b']);
    assert.match(fx.calls[0].path, /^\/me\/calendarView\?/);
    assert.strictEqual(fx.calls[0].options.headers.Prefer, 'outlook.timezone="UTC"');
    assert.strictEqual(fx.calls[1].path, 'https://graph.microsoft.com/v1.0/next');
});

// ── onlineMeeting lookup ─────────────────────────────────────────────

test('getOnlineMeetingByJoinUrl escapes quotes in the OData filter', async () => {
    fx.handler = () => json({ value: [{ id: 'MSo1' }] });
    const m = await artifacts.getOnlineMeetingByJoinUrl(session, "https://teams.microsoft.com/l/it's");
    assert.strictEqual(m.id, 'MSo1');
    const filter = decodeURIComponent(fx.calls[0].path.split('$filter=')[1]);
    assert.strictEqual(filter, "JoinWebUrl eq 'https://teams.microsoft.com/l/it''s'");
});

test('getOnlineMeetingByJoinUrl → null when Graph lists nothing (not the organizer)', async () => {
    fx.handler = () => json({ value: [] });
    assert.strictEqual(await artifacts.getOnlineMeetingByJoinUrl(session, 'https://teams.microsoft.com/l/x'), null);
});

test('a failed Graph answer is classified: switches, access policy, scope, forbidden, throttled', async () => {
    const cases = [
        [graphError(403, 'Forbidden', 'GraphAccessToTranscriptsDisabled'), 'transcript_access_disabled', 403],
        [graphError(403, 'SpeakerAttributionNotAllowed'), 'speaker_attribution_disabled', 403],
        [graphError(403, 'Forbidden', 'No application access policy found for this app.'), 'application_access_policy_missing', 403],
        [graphError(403, 'Forbidden', 'Missing scope permissions on the request'), 'needs_teams_scopes', 403],
        [graphError(403, 'Forbidden', 'Access denied'), 'graph_forbidden', 403],
        [graphError(404, 'NotFound'), 'not_found', 404],
        [graphError(429, 'TooManyRequests'), 'graph_throttled', 503],
        [graphError(503, 'ServiceUnavailable'), 'graph_throttled', 503],
        [graphError(504, 'GatewayTimeout'), 'graph_throttled', 503],
        [graphError(500, 'Boom'), 'failed', 502],
        [new Response('<html>bad gateway</html>', { status: 502 }), 'failed', 502],
    ];
    for (const [response, code, status] of cases) {
        fx.handler = () => response;
        await assert.rejects(artifacts.listTranscripts(session, 'MSo1'), (err) => err.code === code && err.status === status, code);
    }
});

test('a plain 403 is graph_forbidden, no longer "not the organizer", and says what may block it', async () => {
    fx.handler = () => graphError(403, 'Forbidden', 'Access denied');
    await assert.rejects(artifacts.listRecordings(session, 'MSo1'), (err) => {
        assert.strictEqual(err.code, 'graph_forbidden');
        assert.notStrictEqual(err.code, 'not_organizer');
        assert.match(err.message, /^Listing Teams recordings: Microsoft refused access \(a permission, licence or Teams policy blocks it\)$/);
        return true;
    });
    fx.handler = () => graphError(403, 'Forbidden', 'No application access policy found for this app.');
    await assert.rejects(artifacts.listRecordings(session, 'MSo1'),
        (err) => err.message === 'Listing Teams recordings: no Teams application access policy allows this app for this user');
});

test('the transcript switch is found in innerError.code when the message does not name it', async () => {
    const nested = (inner) => json({ error: { code: 'Forbidden', message: 'Access denied', ...inner } }, 403);
    fx.handler = () => nested({ innerError: { code: 'GraphAccessToTranscriptsDisabled', date: '2026-11-10T00:00:00' } });
    await assert.rejects(artifacts.listTranscripts(session, 'MSo1'), (err) => err.code === 'transcript_access_disabled');
    // Lower-case innererror, two levels deep.
    fx.handler = () => nested({ innererror: { code: 'AccessDenied', innererror: { code: 'SpeakerAttributionNotAllowed' } } });
    await assert.rejects(artifacts.listTranscripts(session, 'MSo1'), (err) => err.code === 'speaker_attribution_disabled');
    // Nested deeper than the walk goes: not found, so the plain 403 stays graph_forbidden.
    let deep = { code: 'GraphAccessToTranscriptsDisabled' };
    for (let i = 0; i < 6; i++) deep = { code: `Level${i}`, innerError: deep };
    fx.handler = () => nested({ innerError: deep });
    await assert.rejects(artifacts.listTranscripts(session, 'MSo1'), (err) => err.code === 'graph_forbidden');
});

test('graphUserBase: /me without a user path, a /users/<guid> path everywhere, anything else refused', async () => {
    assert.strictEqual(artifacts.graphUserBase({ accessToken: 'at' }), '/me');
    assert.strictEqual(artifacts.graphUserBase(null), '/me');
    assert.strictEqual(artifacts.graphUserBase({ graphUserPath: null }), '/me');
    const oid = '0F0E0D0C-0B0A-4908-8706-050403020100';
    assert.strictEqual(artifacts.graphUserBase({ graphUserPath: `/users/${oid}` }), `/users/${oid}`);
    for (const bad of ['', '/me', '/users/', `/users/${oid}/`, `/users/${oid}/drive`, '/users/member@fixture.test',
        `/groups/${oid}`, `https://graph.microsoft.com/v1.0/users/${oid}`, 42]) {
        assert.throws(() => artifacts.graphUserBase({ graphUserPath: bad }), (err) => err.code === 'failed', String(bad));
    }

    const app = { accessToken: 'at', graphUserPath: `/users/${oid}` };
    fx.handler = (p, options) => {
        if (options.method === 'PATCH') return new Response(null, { status: 204 });
        if (p.includes('/content')) return new Response(p.includes('/transcripts/') ? 'WEBVTT\n\n' : new Uint8Array(10), { status: 200 });
        return json({ value: [{ id: 'MSo1' }] });
    };
    await artifacts.getOnlineMeetingByJoinUrl(app, 'https://teams.microsoft.com/l/x');
    await artifacts.listRecordings(app, 'MSo1');
    await artifacts.listTranscripts(app, 'MSo1');
    await artifacts.fetchTranscriptVtt(app, { meetingId: 'MSo1', transcriptId: 'T1' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-dl-'));
    await artifacts.downloadRecordingToFile(app, { meetingId: 'MSo1', recordingId: 'R1', destPath: path.join(dir, 'r.mp4') });
    fs.rmSync(dir, { recursive: true, force: true });
    await artifacts.setRecordAutomatically(app, { joinUrl: 'https://teams.microsoft.com/l/x', enabled: true });
    assert.strictEqual(fx.calls.length, 7);
    for (const call of fx.calls) assert.ok(call.path.startsWith(`/users/${oid}/onlineMeetings`), call.path);

    fx.calls = [];
    await assert.rejects(artifacts.listRecordings({ accessToken: 'at', graphUserPath: '/users/x' }, 'MSo1'), (err) => err.code === 'failed');
    assert.strictEqual(fx.calls.length, 0, 'an invalid path never reaches Graph');
});

test('without a user path every artifact call reads /me, exactly as before', async () => {
    fx.handler = () => json({ value: [] });
    await artifacts.listTranscripts(session, 'MSo1');
    await artifacts.getOnlineMeetingByJoinUrl(session, 'https://teams.microsoft.com/l/x');
    assert.deepStrictEqual(fx.calls.map((c) => c.path.split('?')[0]), ['/me/onlineMeetings/MSo1/transcripts', '/me/onlineMeetings']);
});

test('ids with a slash are encoded, never turned into a path', async () => {
    fx.handler = () => json({ value: [] });
    await artifacts.listRecordings(session, 'ab/users+x=');
    assert.strictEqual(fx.calls[0].path, '/me/onlineMeetings/ab%2Fusers%2Bx%3D/recordings');
    await assert.rejects(artifacts.listRecordings(session, 'ab/../users'), /Not a valid Teams meeting id/);
    await assert.rejects(artifacts.listRecordings(session, 'bad id'), /Not a valid Teams meeting id/);
});

// ── occurrence matching ──────────────────────────────────────────────

test('pickArtifactForSlot picks the occurrence that overlaps the calendar slot', () => {
    const items = [
        { id: 'monday', createdDateTime: '2026-09-28T09:01:00Z', endDateTime: '2026-09-28T09:29:00Z' },
        { id: 'today', createdDateTime: '2026-10-01T09:02:00Z', endDateTime: '2026-10-01T09:31:00Z' },
        { id: 'later-same-day', createdDateTime: '2026-10-01T14:00:00Z', endDateTime: '2026-10-01T14:30:00Z' },
    ];
    const slot = { meetingStart: '2026-10-01T09:00:00Z', meetingEnd: '2026-10-01T09:30:00Z' };
    assert.strictEqual(artifacts.pickArtifactForSlot(items, slot).id, 'today');
    // Nothing overlaps → nearest inside the window.
    const late = [{ id: 'late', createdDateTime: '2026-10-01T10:00:00Z', endDateTime: '2026-10-01T10:20:00Z' }];
    assert.strictEqual(artifacts.pickArtifactForSlot(late, slot).id, 'late');
    // Outside the window → nothing.
    assert.strictEqual(artifacts.pickArtifactForSlot([items[0]], slot), null);
    assert.strictEqual(artifacts.pickArtifactForSlot([], slot), null);
});

// ── download ─────────────────────────────────────────────────────────

test('downloadRecordingToFile streams to disk and refuses an oversized body', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-dl-'));
    const dest = path.join(dir, 'r.mp4');
    fx.handler = () => new Response(new Uint8Array(1000), { status: 200 });
    const ok = await artifacts.downloadRecordingToFile(session, { meetingId: 'MSo1', recordingId: 'R1', destPath: dest, maxBytes: 5000 });
    assert.strictEqual(ok.size, 1000);
    assert.strictEqual(fs.statSync(dest).size, 1000);

    fx.handler = () => new Response(new Uint8Array(1000), { status: 200, headers: { 'content-length': '1000' } });
    await assert.rejects(
        artifacts.downloadRecordingToFile(session, { meetingId: 'MSo1', recordingId: 'R1', destPath: dest, maxBytes: 10 }),
        (err) => err.code === 'recording_too_large',
    );

    // No Content-Length: the running count still stops it, and nothing is left behind.
    const dest2 = path.join(dir, 'r2.mp4');
    fx.handler = () => new Response(new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(600)); c.enqueue(new Uint8Array(600)); c.close(); },
    }), { status: 200 });
    await assert.rejects(
        artifacts.downloadRecordingToFile(session, { meetingId: 'MSo1', recordingId: 'R1', destPath: dest2, maxBytes: 1000 }),
        (err) => err.code === 'recording_too_large',
    );
    assert.ok(!fs.existsSync(dest2));
    fs.rmSync(dir, { recursive: true, force: true });
});

// ── VTT ──────────────────────────────────────────────────────────────

test('parseTeamsVtt keeps speaker names, times and decoded text', () => {
    const vtt = [
        'WEBVTT',
        '',
        '0f1a/12-0',
        '00:00:01.500 --> 00:00:04.000',
        '<v Tom Kooy>Goedemorgen allemaal &amp; welkom.</v>',
        '',
        '00:01:02.000 --> 00:01:05.250',
        '<v An de Vries>Dank je.</v>',
        '',
        '00:01:06.000 --> 00:01:07.000',
        'Zonder spreker',
        '',
    ].join('\r\n');
    const out = artifacts.parseTeamsVtt(vtt);
    assert.deepStrictEqual(out.segments, [
        { start: 1.5, end: 4, text: 'Goedemorgen allemaal & welkom.', speakerId: 'Tom Kooy' },
        { start: 62, end: 65.25, text: 'Dank je.', speakerId: 'An de Vries' },
        { start: 66, end: 67, text: 'Zonder spreker', speakerId: 'Unknown' },
    ]);
    assert.strictEqual(out.text, 'Goedemorgen allemaal & welkom. Dank je. Zonder spreker');
    assert.deepStrictEqual(artifacts.parseTeamsVtt('WEBVTT\n\n').segments, []);
});

// ── recordAutomatically ──────────────────────────────────────────────

test('setRecordAutomatically PATCHes the organizer\'s meeting and never throws', async () => {
    fx.handler = (p, options) => (options.method === 'PATCH' ? new Response(null, { status: 204 }) : json({ value: [{ id: 'MSo1' }] }));
    assert.deepStrictEqual(await artifacts.setRecordAutomatically(session, { joinUrl: 'https://teams.microsoft.com/l/x', enabled: true }), { ok: true });
    const patch = fx.calls.find(c => c.options.method === 'PATCH');
    assert.strictEqual(patch.path, '/me/onlineMeetings/MSo1');
    assert.deepStrictEqual(JSON.parse(patch.options.body), { recordAutomatically: true });

    fx.handler = () => json({ value: [] });
    assert.deepStrictEqual(await artifacts.setRecordAutomatically(session, { joinUrl: 'x', enabled: true }), { error: 'not_organizer' });

    fx.handler = (p, options) => (options.method === 'PATCH' ? graphError(403, 'Forbidden', 'Insufficient scope') : json({ value: [{ id: 'MSo1' }] }));
    assert.deepStrictEqual(await artifacts.setRecordAutomatically(session, { joinUrl: 'x', enabled: true }), { error: 'needs_teams_scopes' });

    fx.handler = () => { throw new Error('network'); };
    assert.deepStrictEqual(await artifacts.setRecordAutomatically(session, { joinUrl: 'x', enabled: true }), { error: 'error' });

    // A plain 403 on the PATCH (graph_forbidden) keeps the outcome vocabulary its callers map.
    fx.handler = (p, options) => (options.method === 'PATCH' ? graphError(403, 'Forbidden', 'Access denied') : json({ value: [{ id: 'MSo1' }] }));
    assert.deepStrictEqual(await artifacts.setRecordAutomatically(session, { joinUrl: 'x', enabled: true }), { error: 'error' });
});

// ── a busy calendar, several recordings, a 403 that is not about scopes ──

test('the recently-ended scan reads newest first and follows more than three pages', async () => {
    let page = 0;
    const ended = (id, minsAgo) => ({
        id, onlineMeeting: { joinUrl: `https://teams.microsoft.com/l/${id}` },
        start: { dateTime: new Date(Date.now() - (minsAgo + 30) * 60_000).toISOString() },
        end: { dateTime: new Date(Date.now() - minsAgo * 60_000).toISOString() },
    });
    fx.handler = () => {
        page += 1;
        return json(page < 5
            ? { value: [ended(`m${page}`, 60 * page)], '@odata.nextLink': `https://graph.microsoft.com/v1.0/next${page}` }
            : { value: [ended('m5', 60 * 5)] });
    };
    const out = await calendar.listRecentlyEndedTeamsMeetings({ session, lookbackHours: 168, graceMinutes: 0 });
    assert.deepStrictEqual(out.map((m) => m.eventId), ['m1', 'm2', 'm3', 'm4', 'm5']);
    assert.match(decodeURIComponent(fx.calls[0].path), /\$orderby=start\/dateTime desc/);
});

test('a 403 that mentions "permission" but no scope or consent is not labelled "reconnect"', async () => {
    fx.handler = () => graphError(403, 'Forbidden', 'You do not have permission to access this file');
    await assert.rejects(() => artifacts.listRecordings(session, 'MSo1'), (err) => err.code === 'graph_forbidden');
});

test('artifactsForSlot lists every part of a recording that was stopped and restarted', () => {
    const slot = { meetingStart: '2026-11-03T09:00:00Z', meetingEnd: '2026-11-03T11:00:00Z' };
    const items = [
        { id: 'R2', createdDateTime: '2026-11-03T10:40:00Z', endDateTime: '2026-11-03T10:59:00Z' },
        { id: 'R1', createdDateTime: '2026-11-03T09:01:00Z', endDateTime: '2026-11-03T10:10:00Z' },
        { id: 'OTHER', createdDateTime: '2026-11-10T09:01:00Z', endDateTime: '2026-11-10T10:10:00Z' },
    ];
    assert.deepStrictEqual(artifacts.artifactsForSlot(items, slot).map((a) => a.id), ['R1', 'R2']);
});
