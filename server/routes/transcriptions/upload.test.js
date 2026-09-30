/**
 * Upload-route — POST /api/transcriptions (async-202 + achtergrondpijplijn).
 *
 * ── WAAROM DIT BESTAND BESTAAT ──────────────────────────────────────
 * Dit is de schrijver waar bij een mislukte artefactpass daadwerkelijk iets te
 * WISSEN valt: de notitie bestaat al (status 'processing'), is zichtbaar en
 * bewerkbaar, en de pijplijn landt er minuten later bovenop. Toch had de hele
 * upload-helft van de poort — `artifactsUsable` rond actionItems/decisions/
 * questions/tagsIfEmpty, plus de notitieregel — geen enkele test: de poort kon
 * terug naar de oude rauwe schrijfactie zonder dat één transcriptie-suite piepte.
 *
 * De multer-middleware is vervangen door een doorlaat (er is geen echte
 * multipart-stream in dit harnas); `req.file` wordt door de dispatch gezet,
 * precies zoals multer dat zou doen.
 *
 * Draaien: cd server && node --test --test-force-exit routes/transcriptions/upload.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── Een echt bestand op schijf: de route kopieert het naar saved-recordings ──
const AUDIO_PATH = path.join(os.tmpdir(), `upload-test-${Date.now()}.webm`);
fs.writeFileSync(AUDIO_PATH, 'fake-audio-bytes');
// De route bewaart de audio echt op schijf (saved-recordings); ruim op wat
// dit harnas daar heeft achtergelaten.
const savedCopies = new Set();
test.after(() => {
    try { fs.unlinkSync(AUDIO_PATH); } catch (_) {}
    for (const f of savedCopies) { try { fs.unlinkSync(f); } catch (_) {} }
});

// multer → doorlaat. `upload.single('audio')` mag in dit harnas niets doen.
stub('multer', Object.assign(() => ({ single: () => (req, _res, next) => next() }), {
    diskStorage: () => ({}), memoryStorage: () => ({}),
}));

const creates = [];        // createTranscription-payloads
const updates = [];        // updateTranscription-aanroepen
stub('../../stores/transcriptionStore', {
    createTranscription: async (payload) => {
        creates.push(payload);
        if (payload.audioPath) savedCopies.add(payload.audioPath);
        return { id: 't-new', ...payload };
    },
    updateTranscription: async (id, userId, patch) => { updates.push({ id, userId, patch }); return { id }; },
});
stub('../../stores/configStore', {
    getConfig: async (k) => (k === 'transcription_provider' ? 'whisperx' : null),
    getSecret: async () => null,
});
stub('../../stores/userStore', { getUser: async () => ({ firstName: 'Tom', groups: [] }), getAllGroups: async () => [] });
stub('../../auth', { resolveUserOrgIds: async () => new Set(['org-1']) });
stub('../../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../../stores/summaryTemplateStore', { resolveDefaultTemplate: async () => null, resolveDefaultPrompt: async () => null });
stub('../../stores/storageStore', { getStatus: () => ({ configured: false }), isAvailable: () => false });
stub('../../core/meetingNotes/savedAudioStore', {
    savedAudioKey: (base) => `saved-recordings/${base}`,
    persistSavedAudioToStorage: async () => ({ ok: false, reason: 'not_configured' }),
});

// De PURE helpers echt, de LLM-helpers gestubd. `artifactsUsable` en
// `buildPipelineNotices` zijn met opzet de echte: welke uitkomst deze route
// mag wegschrijven en of hij het meldt, is precies wat hier op het spel staat.
const pure = require('../../core/meetingNotes/transcriptArtifacts');
let artifactsResult = null;   // wat extractMeetingArtifacts teruggeeft (per test)
stub('../../core/meetingNotes/summaryHelpers', {
    transcribeWithWhisperX: async () => ({
        text: 'hallo hoi',
        segments: [
            { speakerId: 'speaker_0', start: 0, end: 5, text: 'hallo' },
            { speakerId: 'speaker_1', start: 6, end: 9, text: 'hoi' },
        ],
    }),
    transcribeWithScaleway: async () => ({ segments: [] }),
    identifySpeakerNames: async () => null,
    generateMeetingSummary: async () => 'Samenvatting van de meeting.',
    generateMeetingTitle: async () => 'AI titel',
    generateChapters: async () => [{ title: 'Opening', start: '00:00' }],
    generateSpeakerSummaries: async () => ({}),
    extractMeetingArtifacts: async () => artifactsResult,
    // Puur — de echte implementaties, geen stubs die kunnen wegdrijven.
    applySpeakerSummaries: pure.applySpeakerSummaries,
    tagSpeakerProvenance: pure.tagSpeakerProvenance,
    toContextBias: pure.toContextBias,
    applySpeakerNames: pure.applySpeakerNames,
    fillGenericSpeakerLabels: pure.fillGenericSpeakerLabels,
    buildTranscriptArtifacts: pure.buildTranscriptArtifacts,
    buildPipelineNotices: pure.buildPipelineNotices,
    artifactsUsable: pure.artifactsUsable,
    ARTIFACTS_FAILED: pure.ARTIFACTS_FAILED,
});

// Filing into a project: the access decision is projects/meetingFiling.js's
// own (meetingFiling.test.js); here only how the upload route USES the answer.
const target = { asked: [], announced: [], answer: { ok: true, projectId: 'p1' }, throws: false };
stub('../../projects/meetingFiling', {
    resolve: async (userId, orgId, projectId) => {
        target.asked.push({ userId, orgId, projectId });
        if (target.throws) throw new Error('projects table is down');
        return target.answer;
    },
    announce: async (projectId, actorId, meetingId) => { target.announced.push({ projectId, actorId, meetingId }); },
});

const router = require('./upload');

function dispatch({ body = {}, file = true, user = 'owner-1' } = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url: '/', query: {}, headers: {}, body,
            session: user ? { isAuthenticated: true, user: { id: user } } : null,
            ...(file ? { file: { path: AUDIO_PATH, originalname: 'standup.webm', size: 17 } } : {}),
            get(name) { return this.headers[String(name).toLowerCase()]; },
            setTimeout() {},
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
            headersSent: false,
        };
        router(req, res, (err) => reject(err || new Error('viel door de router heen')));
    });
}

/** De 202 komt vóór de achtergrondpijplijn; wacht op zijn afdruk. */
async function waitFor(cond, ms = 4000) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms) throw new Error('time-out op de achtergrondpijplijn');
        await new Promise(r => setTimeout(r, 10));
    }
}

/** De laatste update die de notitie afrondt (status 'completed'). */
function completion() {
    return updates.map(u => u.patch).filter(p => p.status === 'completed').pop();
}

test.beforeEach(() => {
    // De route ruimt de tijdelijke upload na afloop op (fs.unlinkSync), dus
    // elke test heeft zijn eigen kopie nodig.
    fs.writeFileSync(AUDIO_PATH, 'fake-audio-bytes');
    creates.length = 0;
    updates.length = 0;
    target.asked.length = 0;
    target.announced.length = 0;
    target.answer = { ok: true, projectId: 'p1' };
    target.throws = false;
    artifactsResult = {
        actionItems: [{ id: 'ai-0', text: 'Offerte sturen', assignee: 'Tom', timestamp: '00:02', done: false }],
        decisions: [{ id: 'd-0', text: 'Besloten: plan A', timestamp: '00:03' }],
        questions: [{ id: 'q-0', text: 'Wie regelt de zaal?', timestamp: '00:04', open: true }],
        tags: ['planning'],
        ok: true,
    };
});

test('een GESLAAGDE pass schrijft de drie lijsten en de tags weg', async () => {
    const res = await dispatch();
    assert.strictEqual(res.statusCode, 202);
    await waitFor(() => !!completion());

    const p = completion();
    assert.deepStrictEqual(p.actionItems, artifactsResult.actionItems);
    assert.deepStrictEqual(p.decisions, artifactsResult.decisions);
    assert.deepStrictEqual(p.questions, artifactsResult.questions);
    assert.deepStrictEqual(p.tagsIfEmpty, ['planning'], 'auto-tags vullen alleen een lege kolom');
    // Geen notitieregel op een geslaagde pass.
    assert.strictEqual(p.summary, 'Samenvatting van de meeting.');
});

test('een MISLUKTE pass laat de drie kolommen ONAANGERAAKT en zegt het op de notitie', async () => {
    // De notitie staat op 'processing' maar is al open en bewerkbaar: wie in
    // dat venster een besluit vastlegt, moet het niet door een pass verliezen
    // die nooit gedraaid heeft. `undefined` betekent bij updateTranscription
    // "raak deze kolom niet aan" — een LEGE lijst zou hem juist wissen.
    artifactsResult = pure.ARTIFACTS_FAILED;
    await dispatch();
    await waitFor(() => !!completion());

    const p = completion();
    assert.strictEqual('actionItems' in p, false, 'action_items wordt niet geschreven');
    assert.strictEqual('decisions' in p, false, 'decisions wordt niet geschreven');
    assert.strictEqual('questions' in p, false, 'questions wordt niet geschreven');
    assert.strictEqual('tagsIfEmpty' in p, false, 'geen tags uit een pass die niet gedraaid heeft');
    // En het scherm KAN het zeggen: de notitieregel is het enige kanaal dat na
    // de 202 nog over is.
    assert.match(p.summary, /actiepunten/i, 'de notitie meldt de mislukte pass');
    assert.ok(p.summary.includes('Samenvatting van de meeting.'), 'de samenvatting zelf blijft staan');
});

test('een antwoord ZONDER lijsten telt niet als geslaagde pass', async () => {
    // De oude poort was `ok !== false`; een vorm die de vlag niet zet kwam er
    // dan doorheen en `artifacts.actionItems` (undefined) wiste de kolom leeg.
    artifactsResult = {};
    await dispatch();
    await waitFor(() => !!completion());

    const p = completion();
    assert.strictEqual('actionItems' in p, false);
    assert.strictEqual('decisions' in p, false);
    assert.strictEqual('questions' in p, false);
    assert.match(p.summary, /actiepunten/i);
});

test('een GESLAAGDE LEGE pass ruimt de kolommen wél op', async () => {
    // De keerzijde, zodat "versmallen" niet stiekem "nooit meer vervangen"
    // wordt: een vergadering waarin niets is afgesproken hoort verouderde
    // AI-rijen op te ruimen.
    artifactsResult = { actionItems: [], decisions: [], questions: [], tags: [], ok: true };
    await dispatch();
    await waitFor(() => !!completion());

    const p = completion();
    assert.deepStrictEqual(p.actionItems, []);
    assert.deepStrictEqual(p.decisions, []);
    assert.deepStrictEqual(p.questions, []);
    assert.strictEqual('tagsIfEmpty' in p, false, 'geen lege tag-lijst over bestaande tags heen');
    assert.strictEqual(p.summary, 'Samenvatting van de meeting.', 'geen notitieregel: de pass is gewoon gelukt');
});

// ═══ Filing the new note into a project ═══════════════════════════════

test('with a projectId the uploader may use, the note is created IN the project and announced', async () => {
    const res = await dispatch({ body: { projectId: 'p1' } });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.projectId, 'p1');
    assert.strictEqual(target.asked.length, 1);
    assert.strictEqual(target.asked[0].userId, 'owner-1');
    assert.strictEqual(target.asked[0].projectId, 'p1');
    assert.strictEqual(creates.length, 1);
    assert.strictEqual(creates[0].projectId, 'p1', 'filed at birth, in the same INSERT');
    assert.deepStrictEqual(target.announced, [{ projectId: 'p1', actorId: 'owner-1', meetingId: 't-new' }]);
    await waitFor(() => !!completion());
});

test('without a projectId nothing about projects is asked and the note is private', async () => {
    const res = await dispatch({ body: { projectId: '' } });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.projectId, null);
    assert.deepStrictEqual(target.asked, []);
    assert.strictEqual(creates[0].projectId, null);
    assert.deepStrictEqual(target.announced, []);
    await waitFor(() => !!completion());
});

test('a refused project stops the upload before anything is saved, and the temp file is gone', async () => {
    target.answer = { ok: false, status: 403, code: 'forbidden', error: 'You can view this project, but only its editors can add meeting notes to it.' };
    const res = await dispatch({ body: { projectId: 'p1' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'forbidden');
    assert.strictEqual(creates.length, 0, 'no note');
    assert.deepStrictEqual(target.announced, []);
    assert.strictEqual(fs.existsSync(AUDIO_PATH), false, 'the upload is not left on disk');
});

test('a project access check that cannot be answered is a refusal, never a blind filing', async () => {
    target.throws = true;
    const res = await dispatch({ body: { projectId: 'p1' } });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'project_check_unavailable');
    assert.ok(!JSON.stringify(res.body).includes('projects table'), 'no internal detail');
    assert.strictEqual(creates.length, 0);
});
