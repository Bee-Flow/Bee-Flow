'use strict';

/**
 * What the meeting-note routes accept, and what they say when they refuse
 * (routes/transcriptions/*.js).
 *
 * Four silent fallbacks stood here, all under a 200, and three of them concern what
 * happens to a RECORDING:
 *
 *   - `PATCH /talk-meetings/:token {"record":"false"}` switched automatic recording
 *     ON. The preference was written as `record: !!record`, and the text "false" is
 *     true. `PATCH /gmeet-meetings/:eventId` did the same. The other way round just
 *     as much: a misspelled key switched it OFF.
 *   - `PATCH /:id/publish {"isPublished":true,"sharedGrous":["g-hr"]}` shared the
 *     meeting with the WHOLE ORGANISATION: the group list dropped out, and an empty
 *     list on a published note means everyone.
 *   - `POST /from-nextcloud {"languge":"en"}` let an English recording be transcribed
 *     in Dutch — not visible from the answer.
 *   - `POST /:id/regenerate-summary {"templatId":"tpl_1"}` rewrote the summary with
 *     the built-in 'general' template and stamped that name under it.
 *
 * What this file records is the part where a caller can do something about it:
 *
 *   - the 400 NAMES the field (`body.record`), not just "invalid";
 *   - the message is a sentence, also for a field that is simply missing;
 *   - the stores are not reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/transcriptions/transcriptions.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const express = require('express');

const SERVER = path.resolve(__dirname, '..', '..');
const { mockModule: mock } = require('../../testUtils/moduleMock');

// Every store call ends up in `touched`. A refused request must leave it empty.
let touched = [];
/** @type {Error | null} */
let ingestFails = null;
const spy = (what, value) => (...args) => { touched.push({ what, args }); return value; };

const NOTE = {
    id: 't-1', userId: 'u1', isOwner: true, title: 'Weekstart',
    organizationId: 'org1', segments: [{ speaker: 'Guest-1', start: 0, end: 5, text: 'hoi' }],
    speakers: [{ id: 'Guest-1', speakingSeconds: 5, segments: 1 }],
    transcript: '[Guest-1] 00:00 - 00:05: hoi', tags: [], actionItems: [],
    createdAt: '2026-01-01T00:00:00Z', status: 'completed', language: 'nl',
};

mock(path.join(SERVER, 'stores/transcriptionStore'), {
    getTranscriptions: spy('getTranscriptions', Promise.resolve([])),
    getTranscription: async () => ({ ...NOTE }),
    getSeriesPrevious: async () => null,
    timeoutStuckTranscriptions: async () => 0,
    updateTranscription: spy('updateTranscription', Promise.resolve({ ...NOTE })),
    setPublished: spy('setPublished', Promise.resolve(true)),
    deleteTranscription: spy('deleteTranscription', Promise.resolve(true)),
});
mock(path.join(SERVER, 'auth/permissions'), {
    requireAuth: (req, res, next) => next(),
});
mock(path.join(SERVER, 'auth'), {
    resolveUserOrgIds: async () => new Set(['org1']),
    validateSharedGroupsForOrg: async (_org, groups) => (groups || []).map(String),
});
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async () => ({ id: 'u1', organizationId: 'org1', groups: [], firstName: 'Tom' }),
    getAllGroups: async () => [{ id: 'g-hr', organizationId: 'org1' }],
});
mock(path.join(SERVER, 'stores/meetingPrefsStore'), {
    setRecord: spy('setRecord', Promise.resolve(true)),
    talkIds: () => ['room:abc'],
    gmeetIds: () => ['event:e1'],
    loadMeetingPrefs: async () => ({ opinionFor: () => true }),
});
mock(path.join(SERVER, 'core/meetingNotes/ingestNextcloudRecording'), {
    // `ingestFails` lets a test make the pipeline throw instead.
    ingestNextcloudRecording: (...args) => {
        touched.push({ what: 'ingestNextcloudRecording', args });
        return ingestFails ? Promise.reject(ingestFails) : Promise.resolve({ id: 't-2' });
    },
    // The route reads the room token out of the path to decide whether the
    // recording came from a Talk call; a plain upload path has none.
    parseTalkRoomToken: () => null,
    ACCEPTED_RECORDING_EXTS: ['.ogg', '.mp3', '.mp4'],
});
mock(path.join(SERVER, 'core/meetingNotes/meetingUsage'), {
    usageForMeeting: async () => ({ rows: [], partial: [] }),
    redactForeign: (rows) => rows,
    filedTranscriptSources: async () => [],
});
mock(path.join(SERVER, 'compliance/dataPortability/stampExport'), () => (req, res, next) => next());

const notes = require('./notes');
const noteActions = require('./noteActions');
const speakers = require('./speakers');
const nextcloud = require('./nextcloud');
const gmeet = require('./gmeet');
const usage = require('./usage');
const report = require('./report');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

// Same mount order as routes/transcriptions.js: `GET /:id` in notes.js
// captures every literal path that is not in its RESERVED_GET_PATHS, so the
// sub-routers whose names it reserves have to sit behind it and be reached by
// its `next('route')`.
const router = express.Router();
router.use(usage);
router.use(notes);
router.use(noteActions);
router.use(speakers);
router.use(nextcloud);
router.use(gmeet);
router.use(report);

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { isAuthenticated: true, user: { id: 'u1' } },
            get() { return undefined; }, setTimeout() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {}, getHeader() { return undefined; }, setTimeout() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end(b) { this.body = this.body ?? b; this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched = []; });

/** Geweigerd met 400, het genoemde veld staat in `details`, niets aangeraakt. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, `${what} → ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `de 400 moet ${field} noemen; hij zei ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'een geweigerd verzoek mag de store niet bereiken');
}

// ═══ De opnameschakelaars ═══════════════════════════════════════════

test('de tekst "false" zet een opname niet meer aan', async () => {
    // `record: !!record` — "false" is true, so whoever switched recording OFF with a
    // text switched it ON, for this meeting and, with `applyToSeries`, for the whole series.
    await refuses({ method: 'PATCH', url: '/talk-meetings/abc', body: { record: 'false' } }, 'body.record');
    await refuses({ method: 'PATCH', url: '/gmeet-meetings/e1', body: { record: 'false' } }, 'body.record');
});

test('een verkeerd gespelde schakelaar zet een opname niet meer uit', async () => {
    await refuses({ method: 'PATCH', url: '/talk-meetings/abc', body: { recrod: false } }, 'body');
    const res = await dispatch({ method: 'PATCH', url: '/gmeet-meetings/e1', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'record is true of false.');
    assert.deepStrictEqual(touched, [], 'en de voorkeur blijft staan');
});

test('de schakelaar die het scherm echt verstuurt schrijft nog steeds', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/talk-meetings/abc', body: { record: true, eventUid: 'e-9' } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(touched.find((x) => x.what === 'setRecord').args[0].record, true);
});

// ═══ Publiceren: één groep is geen hele organisatie ═════════════════

test('een verkeerd gespelde groepenlijst deelt de notitie niet meer org-breed', async () => {
    // `sharedGroups` viel weg, `cleanedGroups` werd `[]`, en een lege lijst op
    // een gepubliceerde notitie betekent DE HELE ORGANISATIE.
    await refuses({
        method: 'PATCH', url: '/t-1/publish',
        body: { isPublished: true, sharedGrous: ['g-hr'] },
    }, 'body');
});

test('publiceren blijft een echte boolean vragen', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/t-1/publish', body: { isPublished: 'true' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'isPublished must be a boolean');
    assert.deepStrictEqual(touched, []);
});

test('de body die het scherm echt verstuurt publiceert nog steeds naar één groep', async () => {
    const res = await dispatch({
        method: 'PATCH', url: '/t-1/publish', body: { isPublished: true, sharedGroups: ['g-hr'] },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(touched.find((x) => x.what === 'setPublished').args[3], ['g-hr']);
});

test('een notitie in een project kan niet meer op een andere manier gedeeld worden', async () => {
    const before = touched.length;
    NOTE.projectId = 'p1';
    try {
        for (const body of [{ isPublished: true, sharedGroups: [] }, { isPublished: true, sharedGroups: ['g-hr'] }, { isPublished: false }]) {
            const res = await dispatch({ method: 'PATCH', url: '/t-1/publish', body });
            assert.strictEqual(res.statusCode, 409, JSON.stringify(body));
            assert.strictEqual(res.body.code, 'MEETING_IN_PROJECT');
        }
        assert.strictEqual(touched.length, before, 'nothing was changed');
    } finally { delete NOTE.projectId; }
});

// ═══ De taal waarin er getranscribeerd wordt ════════════════════════

test('een verkeerd gespelde taal transcribeert niet meer in de standaardtaal', async () => {
    await refuses({
        method: 'POST', url: '/from-nextcloud',
        body: { nextcloud_path: '/Talk/abc/a.ogg', languge: 'en' },
    }, 'body');
});

test('een pad blijft verplicht, met dezelfde zin', async () => {
    const res = await dispatch({ method: 'POST', url: '/from-nextcloud', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'nextcloud_path is required');
});

test('de body die het scherm echt verstuurt importeert nog steeds', async () => {
    const res = await dispatch({
        method: 'POST', url: '/from-nextcloud',
        body: { nextcloud_path: '/Talk/abc/a.ogg', language: 'en', title: 'Sprint' },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(touched.find((x) => x.what === 'ingestNextcloudRecording').args[0].language, 'en');
});

test('een onverwachte fout bij het importeren lekt zijn tekst niet meer naar de client', async () => {
    // `res.status(err.status || 500).json({ error: err.message, code })`: een
    // databasefout of een ENOENT gaf de client de query- of padtekst mee.
    const leak = Object.assign(new Error('relation "transcriptions" does not exist at /srv/beeflow/data/uploads'), { code: '42P01' });
    ingestFails = leak;
    try {
        const res = await dispatch({ method: 'POST', url: '/from-nextcloud', body: { nextcloud_path: '/Talk/abc/a.ogg' } });
        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(res.body.error, 'Internal server error');
        assert.ok(res.body.correlationId, 'the client can quote a correlationId');
        assert.strictEqual(res.body.code, undefined);
        assert.doesNotMatch(JSON.stringify(res.body), /does not exist|\/srv\/|42P01/);
    } finally { ingestFails = null; }
});

test('een bedoelde weigering van de import houdt zijn status, code en zin', async () => {
    const ingestError = (message, code, status) => Object.assign(new Error(message), { name: 'IngestError', code, status });
    const cases = [
        ingestError('Nextcloud is not connected for this account', 'not_connected', 400),
        ingestError('This recording has already been imported by someone else. Ask them to share the meeting note with you.', 'already_imported', 409),
        ingestError('Recording exceeds the 500 MB limit. Record audio-only or trim the file.', 'recording_too_large', 413),
        ingestError('Local transcription unavailable. Pick a cloud provider.', 'local_whisper_unavailable', 503),
    ];
    try {
        for (const err of cases) {
            ingestFails = err;
            const res = await dispatch({ method: 'POST', url: '/from-nextcloud', body: { nextcloud_path: '/Talk/abc/a.ogg' } });
            assert.strictEqual(res.statusCode, err.status, err.message);
            assert.strictEqual(res.body.error, err.message);
            assert.strictEqual(res.body.code, err.code);
        }
    } finally { ingestFails = null; }
});

// ═══ De notitie zelf ════════════════════════════════════════════════

test('een verkeerd gespeld sjabloon herschrijft de samenvatting niet meer met "general"', async () => {
    await refuses({
        method: 'POST', url: '/t-1/regenerate-summary', body: { templatId: 'tpl_1' },
    }, 'body');
});

test('een verkeerd gespelde titel wordt geweigerd in plaats van stil overgeslagen', async () => {
    await refuses({ method: 'PATCH', url: '/t-1', body: { tiitle: 'Nieuw', tags: ['sales'] } }, 'body');
});

test('een titel die geen tekst is wordt geweigerd in plaats van als cijfers opgeslagen', async () => {
    await refuses({ method: 'PATCH', url: '/t-1', body: { title: 42 } }, 'body.title');
});

test('een exportformaat dat er niet is wordt geweigerd, niet als markdown geleverd', async () => {
    // `?fromat=txt` was dropped and the default 'md' took over: a markdown file in
    // answer to a request for plain text.
    await refuses({ method: 'GET', url: '/t-1/export?fromat=txt' }, 'query');
    const res = await dispatch({ method: 'GET', url: '/t-1/export?format=pdf' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Unsupported format. Use: md, txt');
});

test('de sprekerbewerking doet geen lege schrijfronde meer', async () => {
    // `{"rename": {...}}` left `renames` at `{}`, after which the route wrote the
    // segments, the speakers and the transcript back UNCHANGED and returned the whole
    // note — which is also what a successful rename looks like.
    await refuses({ method: 'PATCH', url: '/t-1/speakers', body: { rename: { 'Guest-1': 'Tom' } } }, 'body');
});

test('een namenlijst met een typefout laat de her-identificatie niet meer zonder namen draaien', async () => {
    await refuses({ method: 'POST', url: '/t-1/reidentify-speakers', body: { attendes: 'Tom, Anna' } }, 'body');
});

// ═══ Lijst, rapport en de bevestiging ═══════════════════════════════

test('een bladwijzer die niet bestaat wordt geweigerd in plaats van genegeerd', async () => {
    await refuses({ method: 'GET', url: '/?page=2' }, 'query');
});

test('de bladwijzer die de app echt verstuurt bladert nog steeds', async () => {
    const res = await dispatch({ method: 'GET', url: '/?limit=100' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(touched.find((x) => x.what === 'getTranscriptions').args[1].limit, 100);
});

test('een rapport zonder vraag of zonder vergaderingen houdt dezelfde zinnen', async () => {
    const noIds = await dispatch({ method: 'POST', url: '/report', body: { prompt: 'Wat besloten we?' } });
    assert.strictEqual(noIds.statusCode, 400);
    assert.strictEqual(noIds.body.error, 'Select at least one meeting');

    const noPrompt = await dispatch({ method: 'POST', url: '/report', body: { ids: ['t-1'] } });
    assert.strictEqual(noPrompt.statusCode, 400);
    assert.strictEqual(noPrompt.body.error, 'A question or instruction is required');
    assert.deepStrictEqual(touched, []);
});

test('een bevestiging die niemand zo spelt wordt geweigerd in plaats van gelezen als "nee"', async () => {
    await refuses({ method: 'DELETE', url: '/t-1?confirm=ja' }, 'query.confirm');
    await refuses({ method: 'DELETE', url: '/t-1?confrim=1' }, 'query');
});

test('een verwijdering bevestigt nog steeds op beide spellingen die een URL draagt', async () => {
    for (const q of ['?confirm=1', '?confirm=true']) {
        touched = [];
        const res = await dispatch({ method: 'DELETE', url: `/t-1${q}` });
        assert.strictEqual(res.statusCode, 200, `${q} → ${JSON.stringify(res.body)}`);
        assert.ok(touched.some((x) => x.what === 'deleteTranscription'), `${q} moet echt verwijderen`);
    }
});
