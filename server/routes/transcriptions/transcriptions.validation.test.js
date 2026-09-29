'use strict';

/**
 * Wat de vergadernotitie-routes aannemen, en wat ze zeggen als ze weigeren
 * (routes/transcriptions/*.js).
 *
 * Vier stille terugvallen stonden hier, allemaal onder een 200, en drie ervan
 * gaan over wat er met een OPNAME gebeurt:
 *
 *   - `PATCH /talk-meetings/:token {"record":"false"}` zette de automatische
 *     opname AAN. De voorkeur werd geschreven als `record: !!record`, en de
 *     tekst "false" is waar. `PATCH /gmeet-meetings/:eventId` deed hetzelfde.
 *     Andersom net zo: een verkeerd gespelde sleutel zette hem UIT.
 *   - `PATCH /:id/publish {"isPublished":true,"sharedGrous":["g-hr"]}` deelde
 *     de vergadering met de HELE ORGANISATIE: de groepenlijst viel weg, en een
 *     lege lijst op een gepubliceerde notitie betekent iedereen.
 *   - `POST /from-nextcloud {"languge":"en"}` liet een Engelse opname in het
 *     Nederlands transcriberen — niet te zien aan het antwoord.
 *   - `POST /:id/regenerate-summary {"templatId":"tpl_1"}` herschreef de
 *     samenvatting met het ingebouwde 'general'-sjabloon en stempelde díe naam
 *     eronder.
 *
 * Wat dit bestand vastlegt is het deel waar een beller iets mee kan:
 *
 *   - de 400 NOEMT het veld (`body.record`), niet alleen "ongeldig";
 *   - de boodschap is een zin, ook voor een veld dat simpelweg ontbreekt;
 *   - de stores worden niet bereikt, dus een geweigerd verzoek verandert niets.
 *
 * Draaien: cd server && node --test routes/transcriptions/transcriptions.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const express = require('express');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Elke store-aanroep komt in `touched` terecht. Een geweigerd verzoek moet
// hem leeg laten.
let touched = [];
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
    ingestNextcloudRecording: spy('ingestNextcloudRecording', Promise.resolve({ id: 't-2' })),
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
    // `record: !!record` — "false" is waar, dus wie de opname UIT zette met
    // een tekst zette hem AAN, voor deze vergadering en met `applyToSeries`
    // voor de hele serie.
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
    // `?fromat=txt` viel weg en de standaard 'md' nam het over: een
    // markdown-bestand op een vraag om platte tekst.
    await refuses({ method: 'GET', url: '/t-1/export?fromat=txt' }, 'query');
    const res = await dispatch({ method: 'GET', url: '/t-1/export?format=pdf' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Unsupported format. Use: md, txt');
});

test('de sprekerbewerking doet geen lege schrijfronde meer', async () => {
    // `{"rename": {...}}` liet `renames` op `{}` staan, waarna de route de
    // segmenten, de sprekers en het transcript ONGEWIJZIGD terugschreef en de
    // hele notitie terugstuurde — wat een geslaagde hernoeming er ook is.
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
