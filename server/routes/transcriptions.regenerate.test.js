/**
 * Meeting Notes regenerate route — POST /api/transcriptions/:id/regenerate-summary.
 *
 * Pins the template resolution added for custom summary templates:
 *  - a built-in `template` key still works (and an unknown key falls back to general);
 *  - a `templateId` uses the stored prompt, but ONLY if the caller may see it
 *    (otherwise 404 — no leaking another org/user's prompt);
 *  - owner-only, as before.
 *
 * Drives the REAL Express router with require-cache-stubbed collaborators and a
 * stubbed req/res dispatch harness — no HTTP listener, no DB. The pure prompt
 * builder / visibility logic is covered in core/meetingNotes/summaryTemplates.test.js.
 *
 * Run: cd server && node --test routes/transcriptions.regenerate.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const { BUILTIN_TEMPLATES } = require('../core/meetingNotes/summaryTemplates');
const GENERAL_PROMPT = BUILTIN_TEMPLATES.find(t => t.id === 'general').prompt;
const STANDUP_PROMPT = BUILTIN_TEMPLATES.find(t => t.id === 'standup').prompt;

let storedTranscription = null;
let storedTemplate = null;         // what summaryTemplateStore.getById returns
let speakerSummaries = {};         // what generateSpeakerSummaries returns
// What extractMeetingArtifacts returns. Mutable so a test can hand back the
// FAILED shape (`ok: false`) as well as a successful one — the two used to be
// indistinguishable, which is the bug the last two tests in this file guard.
const GOOD_ARTIFACTS = {
    actionItems: [{ id: 'ai-0', text: 'Do it', assignee: 'Tom', timestamp: '00:10', done: false, due: '2026-07-31' }],
    decisions: [{ id: 'd-0', text: 'Besloten: verder met plan A', timestamp: '00:20' }],
    questions: [{ id: 'q-0', text: 'Wie regelt de licentie?', timestamp: '00:30', open: true }],
    tags: ['planning'],
    ok: true,
};
let artifactsResult = GOOD_ARTIFACTS;
// De ENE gedeelde mislukt-waarde, rechtstreeks uit de bron. Een testfixture
// die hem naspeelt (vier lege lijsten + `ok:false`) pint een vorm die de
// echte extractor niet meer produceert.
const { ARTIFACTS_FAILED } = require('../core/meetingNotes/transcriptArtifacts');
const chatCalls = [];              // every llmClient.chat call
const updateCalls = [];            // every transcriptionStore.updateTranscription call
// Wat de store zegt dat er ECHT is weggeschreven. In productie komt dat uit
// het RETURNING van de UPDATE, en het kan van `updates` afwijken: de store
// laat artefacten staan die na het vertrekpunt van de run zijn ontstaan.
// Mutabel, zodat één test dat verschil kan opvoeren.
let updateResult = null;

stub('../stores/transcriptionStore', {
    getTranscription: async (id) => (storedTranscription ? { ...storedTranscription, id } : null),
    updateTranscription: async (id, userId, updates) => {
        updateCalls.push({ id, userId, updates });
        return updateResult || { id };
    },
});
stub('../stores/configStore', { getConfig: async () => null, getSecret: async () => null });
const { Readable } = require('stream');
stub('../stores/storageStore', {
    isAvailable: () => false,
    streamFile: async () => ({ stream: Readable.from(Buffer.from('')), contentType: 'audio/webm', contentLength: 0 }),
    uploadFile: async () => ({}), deleteFile: async () => ({}),
});
stub('../core/llm/llmClient', {
    chat: async (model, messages, opts) => { chatCalls.push({ model, messages, opts }); return { content: 'GENERATED SUMMARY' }; },
});
stub('../core/meetingNotes/summaryHelpers', {
    resolveSmartModel: async () => 'smart-model',
    extractMeetingArtifacts: async () => artifactsResult,
    generateChapters: async () => [{ title: 'Opening', start: '00:00' }],
    generateSpeakerSummaries: async () => speakerSummaries,
    // Pure — use the real merge rather than a stub that could drift.
    applySpeakerSummaries: require('../core/meetingNotes/transcriptArtifacts').applySpeakerSummaries,
    // De ECHTE poort: welke uitkomsten deze route mag wegschrijven is precies
    // wat de laatste tests in dit bestand bewaken.
    artifactsUsable: require('../core/meetingNotes/transcriptArtifacts').artifactsUsable,
    ARTIFACTS_FAILED: require('../core/meetingNotes/transcriptArtifacts').ARTIFACTS_FAILED,
    // Destructured at module load but unused by regenerate:
    identifySpeakerNames: async () => null,
    generateMeetingSummary: async () => 'unused',
    generateMeetingTitle: async () => 'Title',
    toContextBias: (s) => (s ? [s] : []),
    applySpeakerNames: (m) => ({ merged: m, transcript: '', speakers: [] }),
    buildTranscriptArtifacts: () => ({ merged: [], transcript: '', speakers: [], totalDuration: 0 }),
    buildPipelineNotices: () => [],
    SUMMARY_MAX_TOKENS: 8192,
});
stub('../core/voice/azureSpeech', { transcribeWithAzureSpeech: async () => ({}), AZURE_LOCALE_MAP: { nl: 'nl-NL' } });
stub('../integrations/transcriptionTools', { runAzureWhisperBatch: async () => ({}), executeTranscriptionTool: async () => ({}) });
stub('../core/voice/pyannoteClient', { transcribeWithPyannote: async () => ({}) });
stub('../core/voice/localWhisper', { transcribeLocally: async () => null });

stub('../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../auth', { resolveUserOrgIds: async () => new Set(['org-1']) });
stub('../stores/userStore', { getUser: async () => ({ groups: ['g1'], organizationId: 'org-1' }), getAllGroups: async () => [] });
stub('../db', { run: async () => ({ rowCount: 1 }) });
stub('../stores/summaryTemplateStore', {
    getById: async (id) => (storedTemplate && storedTemplate.id === id ? storedTemplate : null),
    resolveDefaultPrompt: async () => null, resolveDefaultTemplate: async () => null,
});

const router = require('./transcriptions');

function dispatch({ method = 'POST', url, user = 'owner-1', body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query: {}, headers: {},
            session: user ? { isAuthenticated: true, user: { id: user } } : null,
            get(name) { return this.headers[String(name).toLowerCase()]; },
            setTimeout() {},
        };
        if (body !== undefined) req.body = body;
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

test.beforeEach(() => {
    chatCalls.length = 0;
    updateCalls.length = 0;
    storedTemplate = null;
    speakerSummaries = {};
    artifactsResult = GOOD_ARTIFACTS;
    updateResult = null;
    storedTranscription = {
        isOwner: true,
        transcript: 'Hello, this is the meeting transcript.',
        language: 'nl',
        // Het moment waarop de store deze rij las, van de DATABASEKLOK. De
        // regeneratie geeft het door aan zijn eigen schrijfactie.
        readAt: '2026-09-07T10:00:00.000Z',
        updatedAt: '2026-09-07T09:55:00.000Z',
        speakers: [
            { id: 'Tom', speakingSeconds: 750, speakingTime: '12:30', segments: 34 },
            { id: 'Sandra', speakingSeconds: 300, speakingTime: '05:00', segments: 12 },
        ],
    };
});

function lastSystemPrompt() {
    const call = chatCalls[0];
    return call.messages.find(m => m.role === 'system').content;
}

test('built-in template key drives the summary and persists', async () => {
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { template: 'standup' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.match(lastSystemPrompt(), /Write the summary in Dutch/);
    assert.ok(lastSystemPrompt().includes(STANDUP_PROMPT), 'uses the standup built-in prompt');
    assert.strictEqual(updateCalls.length, 1);
});

test('unknown built-in key falls back to general (no error)', async () => {
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { template: 'does-not-exist' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(lastSystemPrompt().includes(GENERAL_PROMPT), 'falls back to the general prompt');
});

test('default template key is general when none supplied', async () => {
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(lastSystemPrompt().includes(GENERAL_PROMPT));
});

test('templateId the owner can see uses the stored prompt', async () => {
    storedTemplate = { id: 'tpl-9', scope: 'user', userId: 'owner-1', name: 'Mine', prompt: 'MY CUSTOM PROMPT BODY', organizationId: null, groupId: null };
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { templateId: 'tpl-9' } });
    assert.strictEqual(res.statusCode, 200);
    assert.match(lastSystemPrompt(), /MY CUSTOM PROMPT BODY/);
    assert.ok(!lastSystemPrompt().includes(GENERAL_PROMPT), 'does not fall back to general');
});

test('templateId the caller may NOT see is 404 (no prompt leak, no LLM call)', async () => {
    storedTemplate = { id: 'tpl-x', scope: 'user', userId: 'someone-else', name: 'Theirs', prompt: 'SECRET', organizationId: null, groupId: null };
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { templateId: 'tpl-x' } });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(chatCalls.length, 0);
    assert.strictEqual(updateCalls.length, 0);
});

test('unknown templateId is 404', async () => {
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { templateId: 'nope' } });
    assert.strictEqual(res.statusCode, 404);
});

test('org-scope templateId is usable by a member of that org', async () => {
    storedTemplate = { id: 'tpl-org', scope: 'org', organizationId: 'org-1', name: 'Org', prompt: 'ORG WIDE PROMPT', userId: null, groupId: null };
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { templateId: 'tpl-org' } });
    assert.strictEqual(res.statusCode, 200);
    assert.match(lastSystemPrompt(), /ORG WIDE PROMPT/);
});

test('ephemeral customPrompt is used when no templateId is given', async () => {
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { customPrompt: 'TRY THIS ONCE' } });
    assert.strictEqual(res.statusCode, 200);
    assert.match(lastSystemPrompt(), /TRY THIS ONCE/);
});

test('regenerate persists decisions, questions, due dates and fills empty tags', async () => {
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.decisions.length, 1);
    assert.strictEqual(res.body.questions[0].open, true);
    const { updates } = updateCalls[0];
    assert.strictEqual(updates.decisions[0].text, 'Besloten: verder met plan A');
    assert.strictEqual(updates.questions[0].text, 'Wie regelt de licentie?');
    assert.strictEqual(updates.actionItems[0].due, '2026-07-31');
    // Auto-tags only ever FILL an empty column (tagsIfEmpty), never overwrite.
    assert.deepStrictEqual(updates.tagsIfEmpty, ['planning']);
    assert.strictEqual(updates.tags, undefined);
});

test('regenerate writes per-speaker contributions onto the existing speaker rows', async () => {
    speakerSummaries = { Tom: 'Tom demonstreerde de tool en nam de wensen op.' };
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);

    const { updates } = updateCalls[0];
    const tom = updates.speakers.find((s) => s.id === 'Tom');
    assert.strictEqual(tom.summary, 'Tom demonstreerde de tool en nam de wensen op.');
    // The stats the panel renders must survive the merge untouched.
    assert.strictEqual(tom.speakingSeconds, 750);
    assert.strictEqual(tom.segments, 34);
    // A speaker the model skipped keeps no summary key at all.
    assert.ok(!('summary' in updates.speakers.find((s) => s.id === 'Sandra')));
    // The client needs them back to render without a refetch.
    assert.strictEqual(res.body.speakers.find((s) => s.id === 'Tom').summary, 'Tom demonstreerde de tool en nam de wensen op.');
});

test('regenerate leaves speakers alone when no contribution came back', async () => {
    speakerSummaries = {};
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);
    // Writing speakers on an empty result would be a pointless column rewrite.
    assert.strictEqual(updateCalls[0].updates.speakers, undefined);
});

test('non-owner cannot regenerate (403, no LLM call)', async () => {
    storedTranscription.isOwner = false;
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { template: 'general' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(chatCalls.length, 0);
});

// ── "Opnieuw" must not delete what the person added (M3) ─────────────
//
// This write used to be a total replacement: `actionItems:
// artifacts.actionItems`. Every action the owner had typed themselves — and
// from M3 on, every destination they had picked for one — was gone the moment
// they pressed a button that promises to rewrite the SUMMARY. No undo, no
// warning, and nothing on screen to tell them it had happened.
// core/meetingNotes/actionItems.js is the rule; these are its teeth.

test('regenerate keeps the action the user added and replaces only the AI\'s', async () => {
    storedTranscription.actionItems = [
        // What the extractor produced last time; the stub replaces it below.
        { id: 'ai-0', source: 'ai', text: 'Oud AI-punt', assignee: 'Tom', done: false },
        // What a person typed, with the destination they chose for it.
        {
            id: 'u-77', source: 'user', text: 'Bel de klant', assignee: 'Sandra', done: true,
            destination: { kind: 'automation', ref: 'aut-7', label: 'Weging', at: '2026-09-01T08:30:00.000Z' },
        },
    ];

    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);

    const { actionItems } = updateCalls[0].updates;
    const mine = actionItems.find((i) => i.id === 'u-77');
    assert.ok(mine, 'the user\'s action item survived the regenerate');
    assert.strictEqual(mine.text, 'Bel de klant');
    assert.strictEqual(mine.done, true, 'and kept its done state');
    assert.deepStrictEqual(mine.destination, {
        kind: 'automation', ref: 'aut-7', label: 'Weging', at: '2026-09-01T08:30:00.000Z',
    }, 'and kept the destination it was sent to');

    // The AI's previous item is gone and its replacement is there exactly once.
    assert.deepStrictEqual(actionItems.map((i) => i.text), ['Bel de klant', 'Do it']);
});

// ── Menselijke invoer wint van hergeneratie (M4) ─────────────────────
//
// De vraag die M3 expliciet aan M4 doorgaf. "Opnieuw" gooide van elk AI-punt
// weg of het afgevinkt was en welke tekst iemand er met de hand van gemaakt
// had — en het punt kwam terug onder DEZELFDE `ai-<n>`-id, dus op het scherm
// leek er niets verdwenen te zijn. GOOD_ARTIFACTS levert het punt op anker
// ('00:10', 'Tom') opnieuw op; zie `anchorKey` in core/meetingNotes/actionItems.js.

test('regenerate laat een afgevinkt punt afgevinkt en zet een correctie niet terug', async () => {
    storedTranscription.actionItems = [{
        id: 'ai-0', source: 'ai', assignee: 'Tom', timestamp: '00:10',
        text: 'Do it for Jansen BV',   // met de hand overgetypt...
        aiText: 'Do it',               // ...en dit is wat het model schreef
        done: true,
    }];

    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);

    const { actionItems } = updateCalls[0].updates;
    assert.strictEqual(actionItems.length, 1, 'herkend als hetzelfde punt, dus niet verdubbeld');
    assert.strictEqual(actionItems[0].done, true, 'het vinkje blijft staan');
    assert.strictEqual(actionItems[0].text, 'Do it for Jansen BV', 'de correctie blijft staan');
    // En het scherm krijgt dezelfde lijst terug, anders is het verlies pas na
    // een refetch zichtbaar — en dan is het al gebeurd.
    assert.strictEqual(res.body.actionItems[0].done, true);
    assert.strictEqual(res.body.actionItems[0].text, 'Do it for Jansen BV');
});

test('een afgevinkt punt dat de nieuwe pass niet meer oplevert blijft staan, en zegt dat', async () => {
    storedTranscription.actionItems = [{
        id: 'ai-0', source: 'ai', text: 'Contract tekenen', assignee: 'Sandra', timestamp: '45:00', done: true,
    }];

    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);

    const { actionItems } = updateCalls[0].updates;
    assert.strictEqual(actionItems.length, 2, 'niet verwijderd, en niet opnieuw aangemaakt');
    const kept = actionItems.find((i) => i.text === 'Contract tekenen');
    assert.strictEqual(kept.done, true);
    assert.strictEqual(kept.orphaned, true);
    assert.ok(res.body.actionItems.some((i) => i.orphaned), 'het scherm kan het tonen');
});

test('een AI-punt waar niemand aan zat wordt nog gewoon vervangen', async () => {
    // De keerzijde: zonder deze grens zou "Opnieuw" niets meer verversen.
    storedTranscription.actionItems = [{
        id: 'ai-0', source: 'ai', text: 'Oude formulering', assignee: 'Tom', timestamp: '00:10', done: false,
    }];
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(updateCalls[0].updates.actionItems.map((i) => i.text), ['Do it']);
});

test('a legacy AI item (no `source`) is replaced, so the list cannot grow on every regenerate', async () => {
    storedTranscription.actionItems = [{ id: 'ai-0', text: 'Oud AI-punt', assignee: 'Tom', done: false }];
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(updateCalls[0].updates.actionItems.map((i) => i.text), ['Do it']);
});

test('the answer carries the merged list, not the extractor\'s half', async () => {
    // The client replaces its copy with this. Answering with the AI's half
    // would make the surviving items vanish from the screen until a refetch —
    // indistinguishable, to the person watching, from having lost them.
    storedTranscription.actionItems = [{ id: 'u-77', source: 'user', text: 'Bel de klant' }];
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.deepStrictEqual(res.body.actionItems.map((i) => i.text), ['Bel de klant', 'Do it']);
});


// ── A failed extraction is not an empty meeting ──────────────────────
//
// From M3's adversarial round, confirmed HIGH. extractMeetingArtifacts
// answered four empty arrays for a meeting with nothing in it, a reply it
// could not parse, AND a call that threw. Regenerate merged that third case
// as though the model had legitimately found nothing — so one failed pass
// emptied the action items, the decisions and the questions of a note, from
// the button whose entire promise is "write it again".

test('a failed artifact pass leaves the artifacts exactly as they were', async () => {
    storedTranscription.actionItems = [{ id: 'ai-9', text: 'Already there', source: 'ai' }];
    storedTranscription.decisions = [{ id: 'd-9', text: 'Already decided' }];
    storedTranscription.questions = [{ id: 'q-9', text: 'Already asked', open: true }];
    // DE ECHTE MISLUKT-WAARDE, niet een nagebouwde. Hier stond de OUDE vorm
    // (`{actionItems:[],…,ok:false}`), een waarde die extractMeetingArtifacts
    // niet meer kan teruggeven — een stub die rijker is dan de bron pint het
    // gedrag van de bron niet.
    artifactsResult = ARTIFACTS_FAILED;

    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200, 'the summary still regenerates — only the artifacts are held back');

    const { updates } = updateCalls[0];
    assert.strictEqual(updates.decisions, undefined, 'decisions are not overwritten');
    assert.strictEqual(updates.questions, undefined, 'questions are not overwritten');
    assert.strictEqual(updates.tagsIfEmpty, undefined, 'and no auto-tags from a pass that did not run');
    assert.strictEqual(updates.actionItems.length, 1);
    assert.strictEqual(updates.actionItems[0].text, 'Already there');

    // The answer echoes what was STORED. Sending back the extractor's empties
    // would blank the screen for a write that never happened.
    assert.strictEqual(res.body.artifactsRegenerated, false);
    assert.strictEqual(res.body.decisions.length, 1);
    assert.strictEqual(res.body.questions.length, 1);
});

test('een NIET-HERKENDE vorm is ook geen geslaagde pass — de poort versmalt', async () => {
    // De poort die deze route gebruikt was ooit `artifacts?.ok !== false`, en
    // die liet elk antwoord door dat de vlag niet zette. Een antwoord ZONDER
    // lijsten kwam er dan doorheen als "gelukt", waarna `artifacts.actionItems`
    // (undefined) alle AI-actiepunten, -besluiten en -vragen wiste. Geen enkele
    // regenerate-test merkte dat, want de enige mislukt-fixture zette `ok`.
    storedTranscription.actionItems = [{ id: 'ai-9', text: 'Already there', source: 'ai' }];
    storedTranscription.decisions = [{ id: 'd-9', text: 'Already decided' }];
    storedTranscription.questions = [{ id: 'q-9', text: 'Already asked', open: true }];
    artifactsResult = {};

    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);

    const { updates } = updateCalls[0];
    assert.strictEqual(updates.decisions, undefined, 'decisions worden niet overschreven');
    assert.strictEqual(updates.questions, undefined, 'questions worden niet overschreven');
    assert.strictEqual(updates.tagsIfEmpty, undefined);
    assert.deepStrictEqual(updates.actionItems.map((i) => i.text), ['Already there']);
    assert.strictEqual(res.body.artifactsRegenerated, false, 'en het scherm KAN het zeggen');
    assert.strictEqual(res.body.decisions.length, 1);
    assert.strictEqual(res.body.questions.length, 1);
});

test('een pass met lijsten maar zonder ok-vlag telt WEL — de poort kijkt naar de waarde', async () => {
    // De keerzijde: versmallen mag geen "alleen wat de vlag zet". Wie de drie
    // lijsten heeft, heeft een antwoord gelezen.
    storedTranscription.decisions = [{ id: 'd-9', text: 'Already decided' }];
    artifactsResult = { actionItems: [], decisions: [{ id: 'd-0', text: 'Vers besluit' }], questions: [], tags: [] };
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.body.artifactsRegenerated, true);
    assert.deepStrictEqual(updateCalls[0].updates.decisions.map((d) => d.text), ['Vers besluit']);
});

test('a successful pass still replaces them — the flag only holds failures back', async () => {
    storedTranscription.actionItems = [{ id: 'ai-9', text: 'Already there', source: 'ai' }];
    storedTranscription.decisions = [{ id: 'd-9', text: 'Already decided' }];

    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);

    const { updates } = updateCalls[0];
    assert.strictEqual(updates.decisions[0].text, 'Besloten: verder met plan A');
    assert.ok(!updates.actionItems.some((i) => i.text === 'Already there'), 'the old AI item is replaced');
    assert.strictEqual(res.body.artifactsRegenerated, true);
});


// ── And the same for a decision picked off a transcript line (M4) ────
//
// M4 gives every transcript line a popover, and "Besluit" writes a decision a
// PERSON chose. This write used to be `decisions: artifacts.decisions` — a
// total replacement, defensible only while the extractor was the sole writer
// of that column. From M4 on it is the same silent deletion the action items
// already had fixed, one column over: the card simply has one fewer row than
// it had a second ago, and there is no undo.

test('regenerate keeps the decision the user picked off a line, anchor and all', async () => {
    storedTranscription.decisions = [
        { id: 'd-0', text: 'Wat het model vorige keer vond', timestamp: '00:20' },
        { id: 'ud-77', source: 'user', text: 'We gaan met leverancier B verder', segmentIndex: 12, timestamp: '04:10' },
    ];
    storedTranscription.questions = [
        { id: 'uq-3', source: 'user', text: 'Wie betaalt de licentie?', segmentIndex: 14, open: false },
    ];

    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);

    const { decisions, questions } = updateCalls[0].updates;
    const mine = decisions.find((d) => d.id === 'ud-77');
    assert.ok(mine, 'the decision the person made off a line survived the regenerate');
    assert.strictEqual(mine.text, 'We gaan met leverancier B verder');
    assert.strictEqual(mine.segmentIndex, 12, 'and still points at the line it came from');
    // The model's previous decision is replaced, exactly once, and the
    // person's comes first — same ordering as the action items.
    assert.deepStrictEqual(decisions.map((d) => d.text),
        ['We gaan met leverancier B verder', 'Besloten: verder met plan A']);

    const myQuestion = questions.find((q) => q.id === 'uq-3');
    assert.ok(myQuestion, 'and so did the question they raised');
    assert.strictEqual(myQuestion.open, false, 'answering it is not undone by a regenerate');

    // The client replaces its copy with the ANSWER. Handing back the
    // extractor's half would make the surviving rows vanish from the card
    // until a refetch — indistinguishable, to the person watching, from
    // having lost them.
    assert.deepStrictEqual(res.body.decisions.map((d) => d.text),
        ['We gaan met leverancier B verder', 'Besloten: verder met plan A']);
    assert.strictEqual(res.body.questions.length, 2);
});

test('a legacy decision (extractor id, no source) is still replaced, so the card cannot grow', async () => {
    storedTranscription.decisions = [{ id: 'd-0', text: 'Oud besluit', timestamp: '00:10' }];
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(updateCalls[0].updates.decisions.map((d) => d.text), ['Besloten: verder met plan A']);
});


// ── EN WAT ER TIJDENS DE RUN ZELF BIJKOMT ────────────────────────────
//
// De merge hierboven beschermt `source:'user'` — maar alleen rijen die in de
// momentopname zaten die de run bij de START las. Tussen dat lezen en het
// schrijven zitten VIER LLM-aanroepen (drie ervan gekapt op 540 s), en de
// "Opnieuw"-banner staat boven het tabblad: wie in het transcript blijft en
// een regel als besluit vastlegt, schrijft in precies dat venster. Voor de
// merge is die rij onzichtbaar, en de update wiste hem — zonder melding.
//
// De route kan dat zelf niet oplossen (hij weet niets van wat er ná zijn read
// is gebeurd). Wat hij WEL moet doen is zijn vertrekpunt doorgeven: het
// moment waarop hij zijn invoer las, van dezelfde klok als de stempels
// waartegen de store het straks vergelijkt. Het bewijs dat het SQL daar het
// juiste mee doet staat in stores/transcriptionStore.artifactWindow.pg.test.js,
// tegen een echte Postgres.

test('regenerate geeft het moment waarop hij zijn invoer las mee aan de schrijfactie', async () => {
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
        updateCalls[0].updates.artifactsSince, '2026-09-07T10:00:00.000Z',
        'het vertrekpunt is het readAt van de read, niet een tijd die de route zelf verzint',
    );
});

test('zonder readAt valt het vertrekpunt terug op de laatste schrijftijd van de rij — nooit op een eigen klok', async () => {
    // Een oudere store (of een gestubte) levert geen readAt. `updated_at` komt
    // van dezelfde databaseklok en ligt per definitie vóór onze read, dus hij
    // is een veilige ondergrens. Wat NIET mag is Date.now() van deze node:
    // dat is de tweede klok waar dit venster juist op stukloopt.
    delete storedTranscription.readAt;
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateCalls[0].updates.artifactsSince, '2026-09-07T09:55:00.000Z');
});

test('het antwoord toont wat de store ECHT heeft weggeschreven, inclusief wat tijdens de run ontstond', async () => {
    storedTranscription.decisions = [{ id: 'd-0', text: 'Wat het model vorige keer vond' }];
    // De store meldt terug wat er na de conditionele schrijfactie in de kolom
    // staat: het verse AI-besluit én het besluit dat iemand tijdens de run van
    // een regel plukte. Antwoorden met alleen de merge zou die rij van het
    // scherm halen terwijl hij veilig in de database staat — voor de persoon
    // die kijkt niet te onderscheiden van verliezen.
    updateResult = {
        ok: true,
        // ALLE DRIE de lijsten wijken af van wat de route stuurde. Juist de
        // actiepunten zijn de lijst die de M4-regelpopover en elk vinkje
        // tijdens een run schrijven, dus alle drie horen hier gepind te zijn —
        // niet alleen `decisions`.
        actionItems: [
            { id: 'ai-0', text: 'Do it', source: 'ai' },
            { id: 'ua-live', text: 'TIJDENS DE RUN AFGEVINKT', source: 'user', done: true },
        ],
        decisions: [
            { id: 'd-0', text: 'Besloten: verder met plan A', source: 'ai' },
            { id: 'ud-live', text: 'TIJDENS DE RUN VASTGELEGD', source: 'user' },
        ],
        questions: [
            { id: 'q-0', text: 'Wie regelt de licentie?', source: 'ai', open: true },
            { id: 'uq-live', text: 'TIJDENS DE RUN GESTELD', source: 'user', open: true },
        ],
    };

    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.actionItems.map((i) => i.text),
        ['Do it', 'TIJDENS DE RUN AFGEVINKT']);
    assert.deepStrictEqual(res.body.decisions.map((d) => d.text),
        ['Besloten: verder met plan A', 'TIJDENS DE RUN VASTGELEGD']);
    assert.deepStrictEqual(res.body.questions.map((q) => q.text),
        ['Wie regelt de licentie?', 'TIJDENS DE RUN GESTELD']);
});

test('een oudere store zonder RETURNING valt terug op de merge — het antwoord blijft de MERGE, niet de extractor', async () => {
    // `stored.x || merged` moet de terugval zijn, niet de hoofdweg. Zonder
    // deze test kan de terugval stilletjes de extractor-helft worden en
    // verdwijnen de rijen van de gebruiker van het scherm tot de volgende
    // ophaalronde.
    storedTranscription.actionItems = [{ id: 'u-77', source: 'user', text: 'Bel de klant' }];
    storedTranscription.decisions = [{ id: 'ud-77', source: 'user', text: 'Leverancier B' }];
    storedTranscription.questions = [{ id: 'uq-77', source: 'user', text: 'Wie betaalt?', open: true }];
    updateResult = { id: 't-1' };   // geen artefactlijsten terug

    const res = await dispatch({ url: '/t-1/regenerate-summary', body: {} });
    assert.deepStrictEqual(res.body.actionItems.map((i) => i.text), ['Bel de klant', 'Do it']);
    assert.deepStrictEqual(res.body.decisions.map((d) => d.text), ['Leverancier B', 'Besloten: verder met plan A']);
    assert.deepStrictEqual(res.body.questions.map((q) => q.text), ['Wie betaalt?', 'Wie regelt de licentie?']);
});

// ── MET WELK SJABLOON IS DEZE NOTITIE GESCHREVEN (M4 stap 3) ─────────
//
// `summary_template_id` + `summary_template_version` zijn een uitspraak over
// de tekst die er NU staat. Elke tak van de promptkeuze moet hem dus zetten —
// inclusief de tak die hem juist leeg maakt.

test('een opgeslagen sjabloon stempelt id én de versie van dít moment', async () => {
    storedTemplate = { id: 'tpl-9', scope: 'user', userId: 'owner-1', name: 'Mijn', prompt: 'P', version: 4, organizationId: null, groupId: null };
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { templateId: 'tpl-9' } });
    assert.strictEqual(res.statusCode, 200);

    const { updates } = updateCalls[0];
    assert.strictEqual(updates.summaryTemplateId, 'tpl-9');
    assert.strictEqual(updates.summaryTemplateVersion, 4);
    // En terug naar de client, anders blijft de kaart tot de volgende
    // ophaalronde het vorige sjabloon noemen bij nieuwe tekst.
    assert.strictEqual(res.body.summaryTemplateId, 'tpl-9');
    assert.strictEqual(res.body.summaryTemplateVersion, 4);
});

test('een sjabloon zonder bruikbare versie stempelt wel het id, niet een verzonnen 1', async () => {
    storedTemplate = { id: 'tpl-9', scope: 'user', userId: 'owner-1', name: 'Mijn', prompt: 'P', version: null, organizationId: null, groupId: null };
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { templateId: 'tpl-9' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateCalls[0].updates.summaryTemplateId, 'tpl-9');
    assert.strictEqual(updateCalls[0].updates.summaryTemplateVersion, null);
});

test('een ingebouwd sjabloon stempelt builtin:<sleutel> en geen versie', async () => {
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { template: 'standup' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(updateCalls[0].updates.summaryTemplateId, 'builtin:standup');
    assert.strictEqual(updateCalls[0].updates.summaryTemplateVersion, null);
});

test('een onbekende ingebouwde sleutel stempelt general — de prompt die het écht schreef', async () => {
    // De prompt valt terug op general; de stempel moet dezelfde val maken,
    // anders noemt de notitie een sjabloon dat niet bestaat.
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { template: 'does-not-exist' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(lastSystemPrompt().includes(GENERAL_PROMPT));
    assert.strictEqual(updateCalls[0].updates.summaryTemplateId, 'builtin:general');
});

test('een eenmalige prompt WIST de stempel', async () => {
    // De samenvatting die er nu staat is niet meer die van het vorige
    // sjabloon. De oude stempel laten staan zou een sjabloonnaam plakken op
    // tekst die dat sjabloon nooit geschreven heeft.
    storedTranscription.summaryTemplateId = 'tpl-9';
    storedTranscription.summaryTemplateVersion = 4;
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { customPrompt: 'TRY THIS ONCE' } });
    assert.strictEqual(res.statusCode, 200);

    const { updates } = updateCalls[0];
    assert.ok('summaryTemplateId' in updates, 'de kolom wordt echt geschreven, niet overgeslagen');
    assert.strictEqual(updates.summaryTemplateId, null);
    assert.strictEqual(updates.summaryTemplateVersion, null);
    assert.strictEqual(res.body.summaryTemplateId, null);
});

test('een geweigerd templateId schrijft niets — ook geen stempel', async () => {
    storedTemplate = { id: 'tpl-x', scope: 'user', userId: 'someone-else', name: 'Theirs', prompt: 'SECRET', organizationId: null, groupId: null };
    const res = await dispatch({ url: '/t-1/regenerate-summary', body: { templateId: 'tpl-x' } });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(updateCalls.length, 0);
});
