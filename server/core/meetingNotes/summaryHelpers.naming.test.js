/**
 * summaryHelpers — speaker naming (guard-free) + chapter summaries.
 *
 * Pins the fixes for pyannote speakers coming back as generic "SPEAKER_00":
 *  - naming runs on the SMART tier (not the weak fast tier);
 *  - with no attendee roster and no PII guard, an LLM extraction pass supplies
 *    the candidate roster (introduced names), so naming still works;
 *  - the model may omit ids it can't name, and any generic label it emits is
 *    dropped — those ids get a clean floor label from fillGenericSpeakerLabels;
 *  - generateChapters now carries a per-chapter `summary` through validation.
 *
 * llmClient / speakerEvidence / piiDetection / modelResolver are require-cache
 * stubbed — no DB, no real LLM. Run:
 *   cd server && node --test core/meetingNotes/summaryHelpers.naming.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Controllable LLM responses, routed by the system prompt.
let extractionResponse = '[]';   // extractIntroducedNames
let assignmentResponse = '{}';   // identifySpeakerNames assignment
let chaptersResponse = '[]';     // generateChapters
let artifactsResponse = '{}';    // extractMeetingArtifacts
let artifactsThrow = null;       // extractMeetingArtifacts: laat de LLM-call omvallen
let contributionsResponse = '{}';// generateSpeakerSummaries
const chatCalls = [];

stub('../llm/llmClient', {
    chat: async (model, messages) => {
        const sys = (messages.find(m => m.role === 'system') || {}).content || '';
        const user = (messages.find(m => m.role === 'user') || {}).content || '';
        chatCalls.push({ model, sys, user });
        if (/List the FIRST NAMES/.test(sys)) return { content: extractionResponse };
        if (/Divide the transcript into/.test(sys)) return { content: chaptersResponse };
        if (/structured artifacts/.test(sys)) {
            // Een omgevallen smart-tier (time-out, 500, geen model) — de derde
            // uitkomst, en de enige die niets mag mogen wissen.
            if (artifactsThrow) throw artifactsThrow;
            return { content: artifactsResponse };
        }
        if (/THAT PERSON contributed/.test(sys)) return { content: contributionsResponse };
        return { content: assignmentResponse }; // the transcript-analyst assignment prompt
    },
});
// Guard-free: no PII-guard, so evidence is null (the exact failing environment).
stub('./speakerEvidence', { extractSpeakerEvidence: async () => null });
stub('../privacy/piiDetection', { detectPii: async () => null });
stub('../llm/modelResolver', {
    getEUAwareTiers: async () => ({ smart: { modelId: 'smart-model' } }),
    resolveModelForTierName: async (tierName, { fallback } = {}) => (tierName === 'smart' ? 'smart-model' : (fallback || 'fast-model')),
});

const {
    identifySpeakerNames, generateChapters, fillGenericSpeakerLabels, applySpeakerNames,
    extractMeetingArtifacts, generateSpeakerSummaries, applySpeakerSummaries,
    artifactsUsable, ARTIFACTS_FAILED,
} = require('./summaryHelpers');

const SEGMENTS = [
    { speaker: 'SPEAKER_00', speakerId: 'SPEAKER_00', start: 0, end: 4, text: 'Ik ben Ewald, welkom allemaal.' },
    { speaker: 'SPEAKER_01', speakerId: 'SPEAKER_01', start: 4, end: 8, text: 'Dank je Ewald, ik ben Tom.' },
];
const SPEAKERS = [{ id: 'SPEAKER_00', speakingSeconds: 4 }, { id: 'SPEAKER_01', speakingSeconds: 4 }];

test.beforeEach(() => {
    chatCalls.length = 0;
    extractionResponse = '[]';
    assignmentResponse = '{}';
    chaptersResponse = '[]';
    artifactsResponse = '{}';
    contributionsResponse = '{}';
});

test('no roster + no guard → extracts introduced names, then assigns real names via the smart tier', async () => {
    extractionResponse = '["Ewald","Tom"]';
    assignmentResponse = '{"SPEAKER_00":"Ewald","SPEAKER_01":"Tom"}';

    const mapping = await identifySpeakerNames(SEGMENTS, SPEAKERS, 'nl', null, 'org-1', []);
    assert.deepStrictEqual(mapping, { SPEAKER_00: 'Ewald', SPEAKER_01: 'Tom' });

    // Two calls: the guard-free extraction pass, then the assignment.
    assert.strictEqual(chatCalls.length, 2);
    assert.match(chatCalls[0].sys, /List the FIRST NAMES/);
    assert.match(chatCalls[1].sys, /transcript analyst/);
    // Both ran on the SMART tier, not the old fast-lite model.
    assert.ok(chatCalls.every(c => c.model === 'smart-model'));
});

test('a generic label the model emits is dropped, leaving the id for the floor', async () => {
    extractionResponse = '["Ewald"]';
    // The model names one id and hedges the other with a generic label.
    assignmentResponse = '{"SPEAKER_00":"Ewald","SPEAKER_01":"Spreker 2"}';

    const mapping = await identifySpeakerNames(SEGMENTS, SPEAKERS, 'nl', null, null, []);
    assert.deepStrictEqual(mapping, { SPEAKER_00: 'Ewald' }); // SPEAKER_01 omitted

    // The floor then gives the unnamed id a clean localized label (never raw).
    const filled = fillGenericSpeakerLabels(SPEAKERS, mapping, 'nl');
    assert.deepStrictEqual(filled, { SPEAKER_00: 'Ewald', SPEAKER_01: 'Spreker 1' });
});

test('a supplied attendee roster skips the extraction pass (assignment only)', async () => {
    assignmentResponse = '{"SPEAKER_00":"Ewald","SPEAKER_01":"Tom"}';
    const mapping = await identifySpeakerNames(SEGMENTS, SPEAKERS, 'nl', null, null, ['Ewald', 'Tom']);
    assert.deepStrictEqual(mapping, { SPEAKER_00: 'Ewald', SPEAKER_01: 'Tom' });
    assert.strictEqual(chatCalls.length, 1);
    assert.match(chatCalls[0].sys, /transcript analyst/);
});

test('unparseable assignment reply → null (caller floors every id)', async () => {
    extractionResponse = '[]';
    assignmentResponse = 'sorry, I cannot help with that';
    const mapping = await identifySpeakerNames(SEGMENTS, SPEAKERS, 'nl', null, null, []);
    assert.strictEqual(mapping, null);
});

// ── Voiceprint-pinned speakers (opts.lockedNames) ────────────────────

test('every id pinned by voiceprint → the LLM is never called at all', async () => {
    // The naming step is the most expensive stage in the pipeline; a team where
    // everyone has enrolled should skip it entirely, which also offsets part of
    // the second pyannote job the identification costs.
    const mapping = await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', null, 'org-1', [],
        { lockedNames: { SPEAKER_00: 'Ewald de Groot', SPEAKER_01: 'Tom Smit' } },
    );
    assert.deepStrictEqual(mapping, { SPEAKER_00: 'Ewald de Groot', SPEAKER_01: 'Tom Smit' });
    assert.strictEqual(chatCalls.length, 0);
});

test('a pinned id is withheld from the model and stated as fact in the prompt', async () => {
    assignmentResponse = '{"SPEAKER_01":"Tom"}';
    const mapping = await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', null, 'org-1', ['Ewald de Groot', 'Tom'],
        { lockedNames: { SPEAKER_00: 'Ewald de Groot' } },
    );
    assert.deepStrictEqual(mapping, { SPEAKER_00: 'Ewald de Groot', SPEAKER_01: 'Tom' });

    const assignment = chatCalls.find(c => /transcript analyst/.test(c.sys));
    assert.match(assignment.sys, /ALREADY IDENTIFIED BY VOICEPRINT/);
    assert.match(assignment.sys, /SPEAKER_00 = Ewald de Groot/);
    // The id list is the question being asked; the transcript below it still
    // mentions SPEAKER_00 as a speaker label, which is fine and necessary.
    const idList = assignment.user.split('Language:')[0];
    assert.match(idList, /Speaker IDs \(1\)/);
    assert.ok(!idList.includes('SPEAKER_00'), 'the settled id is not among the ids to name');
    assert.ok(idList.includes('SPEAKER_01'));
});

test('a pinned name is never stripped by the generic-label sanitiser', async () => {
    // Someone genuinely called "Gast" trips looksGenericSpeakerName. Acoustic
    // evidence outranks a text heuristic, so the pin must survive.
    assignmentResponse = '{}';
    const mapping = await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', null, 'org-1', [],
        { lockedNames: { SPEAKER_00: 'Gast' } },
    );
    assert.strictEqual(mapping.SPEAKER_00, 'Gast');
});

test('a pin survives an unparseable LLM reply', async () => {
    assignmentResponse = 'sorry, I cannot help with that';
    const mapping = await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', null, 'org-1', [],
        { lockedNames: { SPEAKER_00: 'Tom Smit' } },
    );
    assert.deepStrictEqual(mapping, { SPEAKER_00: 'Tom Smit' });
});

test('the LLM cannot overwrite a pinned id', async () => {
    // Belt and braces: even if the model volunteers an answer for an id it was
    // not asked about, the voice match wins.
    assignmentResponse = '{"SPEAKER_00":"Someone Else","SPEAKER_01":"Tom"}';
    const mapping = await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', null, 'org-1', [],
        { lockedNames: { SPEAKER_00: 'Ewald de Groot' } },
    );
    assert.strictEqual(mapping.SPEAKER_00, 'Ewald de Groot');
});

test('no opts argument → behaviour is exactly as before (regression guard)', async () => {
    extractionResponse = '["Ewald","Tom"]';
    assignmentResponse = '{"SPEAKER_00":"Ewald","SPEAKER_01":"Tom"}';
    const mapping = await identifySpeakerNames(SEGMENTS, SPEAKERS, 'nl', null, 'org-1', []);
    assert.deepStrictEqual(mapping, { SPEAKER_00: 'Ewald', SPEAKER_01: 'Tom' });
    assert.strictEqual(chatCalls.length, 2);
});

test('voiceprint names alone do NOT claim a complete attendee list', async () => {
    // Without a caller-supplied roster, pinned names prove who IS present, not
    // that nobody else is — so the model must not be told the set is closed and
    // start assigning strangers to colleagues.
    assignmentResponse = '{}';
    await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', null, 'org-1', [],
        { lockedNames: { SPEAKER_00: 'Ewald de Groot' } },
    );
    const assignment = chatCalls.find(c => /transcript analyst/.test(c.sys));
    assert.ok(!/COMPLETE SET OF PEOPLE IN THE ROOM/.test(assignment.sys));
    assert.match(assignment.sys, /NAMES PEOPLE USED IN THIS MEETING: .*Ewald de Groot/);
});

// ── Voiceprint NEGATIVE evidence (opts.ruledOutNames) ────────────────

test('REGRESSION: a ruled-out name is stripped even when the model insists', async () => {
    // The real failure: a 2-person meeting where only Tom was enrolled came out
    // as ONE speaker. The model, told "SPEAKER_01 is Tom" and "the recorder is
    // Tom" and "several ids per name is normal", named the OTHER participant
    // Tom as well — and applySpeakerNames merged them. The voiceprint had
    // already established SPEAKER_00 covers 4% of Tom's turns, i.e. not Tom.
    assignmentResponse = '{"SPEAKER_00":"Tom Smit"}';
    const mapping = await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', 'Tom', 'org-1', [],
        { lockedNames: { SPEAKER_01: 'Tom Smit' }, ruledOutNames: { SPEAKER_00: ['Tom Smit'] } },
    );
    assert.deepStrictEqual(mapping, { SPEAKER_01: 'Tom Smit' }, 'SPEAKER_00 must NOT become Tom');

    // …and the floor then gives the second person their own visible identity.
    const filled = fillGenericSpeakerLabels(SPEAKERS, mapping, 'nl');
    assert.deepStrictEqual(filled, { SPEAKER_01: 'Tom Smit', SPEAKER_00: 'Spreker 1' });
});

test('the exclusion is case- and whitespace-insensitive', async () => {
    assignmentResponse = '{"SPEAKER_00":"  tom smit "}';
    const mapping = await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', null, 'org-1', [],
        { lockedNames: { SPEAKER_01: 'Tom Smit' }, ruledOutNames: { SPEAKER_00: ['Tom Smit'] } },
    );
    assert.ok(!mapping.SPEAKER_00, 'a re-cased spelling must not slip past the exclusion');
});

test('a DIFFERENT name for a ruled-out id is kept — the transcript still names people', async () => {
    // The unenrolled participant introduces themselves; that name is welcome.
    // Only the excluded identity is forbidden.
    assignmentResponse = '{"SPEAKER_00":"Jeroen"}';
    const mapping = await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', null, 'org-1', [],
        { lockedNames: { SPEAKER_01: 'Tom Smit' }, ruledOutNames: { SPEAKER_00: ['Tom Smit'] } },
    );
    assert.deepStrictEqual(mapping, { SPEAKER_01: 'Tom Smit', SPEAKER_00: 'Jeroen' });
});

test('the exclusions and the speaker count reach the prompt', async () => {
    assignmentResponse = '{}';
    await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', null, 'org-1', [],
        {
            lockedNames: { SPEAKER_01: 'Tom Smit' },
            ruledOutNames: { SPEAKER_00: ['Tom Smit'] },
            expectedSpeakers: 2,
        },
    );
    const sys = chatCalls.find(c => /transcript analyst/.test(c.sys)).sys;
    assert.match(sys, /RULED OUT BY VOICEPRINT/);
    assert.match(sys, /SPEAKER_00 is NOT Tom Smit/);
    assert.match(sys, /exactly 2 distinct people/);
    // The "many ids → one name" rule must carry its exception, or it reads as
    // permission to do the very thing the exclusion forbids.
    assert.match(sys, /EXCEPT where a "RULED OUT" line above forbids/);
});

test('END-TO-END: one enrolled + one unenrolled stays TWO speakers', async () => {
    assignmentResponse = '{"SPEAKER_00":"Tom Smit"}';   // the model over-merges
    const mapping = await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', 'Tom', 'org-1', [],
        { lockedNames: { SPEAKER_01: 'Tom Smit' }, ruledOutNames: { SPEAKER_00: ['Tom Smit'] }, expectedSpeakers: 2 },
    );
    const filled = fillGenericSpeakerLabels(SPEAKERS, mapping, 'nl');
    const { speakers } = applySpeakerNames(SEGMENTS, filled);
    assert.strictEqual(speakers.length, 2, `expected 2 speaker rows, got ${JSON.stringify(speakers.map(s => s.id))}`);
    assert.deepStrictEqual(speakers.map(s => s.id).sort(), ['Spreker 1', 'Tom Smit']);
});

test('no ruledOutNames → behaviour is exactly as before', async () => {
    assignmentResponse = '{"SPEAKER_00":"Tom Smit"}';
    const mapping = await identifySpeakerNames(
        SEGMENTS, SPEAKERS, 'nl', null, 'org-1', [],
        { lockedNames: { SPEAKER_01: 'Tom Smit' } },
    );
    assert.deepStrictEqual(mapping, { SPEAKER_01: 'Tom Smit', SPEAKER_00: 'Tom Smit' });
});

test('generateChapters carries a per-chapter summary through validation', async () => {
    const transcript = '[Ewald] 00:00 - 00:10: Opening en welkom.\n[Tom] 00:10 - 00:30: We bespreken de agenda.';
    chaptersResponse = JSON.stringify([
        { title: 'Opening', start: '00:00', summary: 'Ewald opent de vergadering.' },
        { title: 'Agenda', start: '00:10', summary: 'Tom loopt de agenda door.' },
    ]);
    const chapters = await generateChapters(transcript, 'nl', null);
    assert.strictEqual(chapters.length, 2);
    assert.strictEqual(chapters[0].title, 'Opening');
    assert.strictEqual(chapters[0].summary, 'Ewald opent de vergadering.');
    assert.strictEqual(chapters[1].summary, 'Tom loopt de agenda door.');
});

test('generateChapters without a summary field still yields valid chapters', async () => {
    const transcript = '[Ewald] 00:00 - 00:10: Opening.\n[Tom] 00:10 - 00:30: Agenda.';
    chaptersResponse = JSON.stringify([
        { title: 'Opening', start: '00:00' },
        { title: 'Agenda', start: '00:10' },
    ]);
    const chapters = await generateChapters(transcript, 'nl', null);
    assert.strictEqual(chapters.length, 2);
    assert.ok(!('summary' in chapters[0]));
});

test('generateChapters accepts numeric-seconds start values (no empty strip)', async () => {
    const transcript = '[Ewald] 00:00 - 00:10: Opening.\n[Tom] 00:10 - 00:30: Agenda.';
    chaptersResponse = JSON.stringify([
        { title: 'Opening', start: 0, summary: 'Opening.' },
        { title: 'Agenda', start: 10, summary: 'Agenda.' },
    ]);
    const chapters = await generateChapters(transcript, 'nl', null);
    assert.strictEqual(chapters.length, 2);
    assert.deepStrictEqual(chapters.map(c => c.start), ['00:00', '00:10']);
});

test('extractMeetingArtifacts validates due dates, defaults open, and filters person-name tags', async () => {
    const transcript = '[Ewald] 00:00 - 00:10: We besluiten plan A.\n[Tom] 12:30 - 12:40: Ik lever het rapport vrijdag.';
    artifactsResponse = JSON.stringify({
        actionItems: [
            { text: 'Rapport opleveren', assignee: 'Tom', timestamp: '12:30', due: '2026-07-31' },
            { text: 'Zonder deadline', assignee: 'Ewald', timestamp: '00:00', due: 'volgende week' }, // junk due → dropped
            { text: 'Verjaard', assignee: 'Tom', timestamp: '00:00', due: '2030-01-01' },             // >2y out → dropped
        ],
        decisions: [{ text: 'Plan A goedgekeurd', timestamp: '00:00' }, { text: '', timestamp: '00:05' }],
        questions: [{ text: 'Wie regelt budget?', timestamp: '12:30' }],
        tags: ['planning', 'Tom', 'budget', 'PLANNING', 'ewald de boer'],
    });

    const artifacts = await extractMeetingArtifacts(transcript, 'nl', null, {
        meetingDateIso: '2026-07-24',
        personNames: ['Tom Smit', 'Ewald de Boer'],
    });

    assert.strictEqual(artifacts.actionItems.length, 3);
    assert.strictEqual(artifacts.actionItems[0].due, '2026-07-31');
    assert.ok(!('due' in artifacts.actionItems[1]), 'non-ISO due is dropped');
    assert.ok(!('due' in artifacts.actionItems[2]), 'implausibly far due is dropped');
    assert.strictEqual(artifacts.actionItems[0].done, false);
    // M3: the extractor marks its own output. core/meetingNotes/actionItems.js
    // deletes exactly the `source:'ai'` items on a regenerate and keeps the
    // rest, so an unmarked producer would leave that rule leaning on the
    // `ai-<n>` id namespace alone.
    assert.ok(artifacts.actionItems.every((i) => i.source === 'ai'), 'extracted items are marked as the AI\'s');
    // M4: en het model legt zijn EIGEN tekst vast als ijkpunt. Zonder deze
    // stempel kan de merge een met de hand gecorrigeerde tekst niet
    // onderscheiden van een tekst die het model deze keer anders formuleerde,
    // en zet "Opnieuw" de correctie stilletjes terug.
    assert.ok(artifacts.actionItems.every((i) => i.aiText === i.text), 'de extractor legt zijn eigen tekst vast');

    // Empty-text decision dropped; ids assigned.
    assert.deepStrictEqual(artifacts.decisions, [{ id: 'd-0', text: 'Plan A goedgekeurd', timestamp: '00:00' }]);
    // `open` defaults to true when the model omits it.
    assert.deepStrictEqual(artifacts.questions, [{ id: 'q-0', text: 'Wie regelt budget?', timestamp: '12:30', open: true }]);
    // Person names (full + first) and case-duplicates never become tags.
    assert.deepStrictEqual(artifacts.tags, ['planning', 'budget']);
});

test('an unparseable reply is reported as a FAILED pass, not as an empty meeting', async () => {
    // These used to be the same answer, and a caller that overwrites on the
    // strength of it erased everything the last good pass had found.
    //
    // Het onderscheid zat eerst in een VLAG naast vier lege lijsten, en dat is
    // precies wat een schrijver vergeet mee te nemen. Nu draagt de waarde het:
    // een mislukte pass heeft helemaal GEEN lijsten, dus er valt niets uit te
    // lezen om overheen te schrijven.
    artifactsResponse = 'sorry, no JSON today';
    const artifacts = await extractMeetingArtifacts('[X] 00:00 - 00:05: hoi', 'nl', null);
    assert.strictEqual(artifacts, ARTIFACTS_FAILED, 'de ene gedeelde mislukt-waarde');
    assert.strictEqual(artifacts.ok, false);
    assert.strictEqual(artifacts.actionItems, undefined, 'geen lege lijst om mee te wissen');
    assert.strictEqual(artifacts.decisions, undefined);
    assert.strictEqual(artifacts.questions, undefined);
    assert.strictEqual(artifacts.tags, undefined);
    assert.strictEqual(artifactsUsable(artifacts), false);
});

test('an extractor whose LLM call THROWS reports the same failed pass', async () => {
    // De derde uitkomst langs de andere weg: time-out, 500, geen model. Ook
    // hier geen lege lijsten — een aanroeper die dit wegschrijft zou
    // actiepunten, besluiten én vragen van een afgeronde notitie wissen.
    artifactsThrow = new Error('smart tier timed out after 540000ms');
    try {
        const artifacts = await extractMeetingArtifacts('[X] 00:00 - 00:05: hoi', 'nl', null);
        assert.strictEqual(artifacts, ARTIFACTS_FAILED);
        assert.strictEqual(artifacts.actionItems, undefined);
        assert.strictEqual(artifactsUsable(artifacts), false);
    } finally {
        artifactsThrow = null;
    }
});

test('een AFGEKAPT antwoord is ook een mislukte pass, geen halfvolle vergadering', async () => {
    // De vierde uitkomst, en de gevaarlijkste: het model raakt het
    // output-tokenplafond midden in "decisions". parseJsonObject redt dan de
    // sleutels die nog compleet waren en sluit het object zelf af — en de
    // sleutels die het niet haalden zijn simpelweg WEG. Vóór deze fix maakte
    // `asArray` daar lege lijsten van, zei de poort JA, en wiste één druk op
    // "Opnieuw" alle opgeslagen AI-besluiten en -vragen van precies de lange
    // vergadering die het plafond raakte.
    artifactsResponse = '{"actionItems": [{"text": "Offerte sturen", "assignee": "Tom", "timestamp": "00:02"}], "decisions": [{"text": "Budget goedge';
    const artifacts = await extractMeetingArtifacts('[X] 00:00 - 00:05: hoi', 'nl', null);
    assert.strictEqual(artifacts, ARTIFACTS_FAILED, 'afgekapt = niet gelezen, dus de mislukt-waarde');
    assert.strictEqual(artifacts.actionItems, undefined, 'ook de sleutel die het WEL haalde vervangt niets');
    assert.strictEqual(artifacts.decisions, undefined);
    assert.strictEqual(artifactsUsable(artifacts), false);
});

test('een compleet antwoord dat een sleutel WEGLAAT is nog steeds een geslaagde pass', async () => {
    // De keerzijde, zodat de regel hierboven niet stiekem "elk onvolledig
    // antwoord faalt" wordt: dit antwoord is heel (geen salvage), het model
    // noemt alleen `decisions` niet. Dat is het model dat zegt "geen
    // besluiten", en dat MAG een verouderde lijst opruimen.
    artifactsResponse = JSON.stringify({ actionItems: [], questions: [], tags: [] });
    const artifacts = await extractMeetingArtifacts('[X] 00:00 - 00:05: hoi', 'nl', null);
    assert.strictEqual(artifacts.ok, true);
    assert.deepStrictEqual(artifacts.decisions, []);
    assert.strictEqual(artifactsUsable(artifacts), true);
});

test('a meeting that genuinely produced nothing is a SUCCESSFUL empty pass', async () => {
    artifactsResponse = JSON.stringify({ actionItems: [], decisions: [], questions: [], tags: [] });
    const artifacts = await extractMeetingArtifacts('[X] 00:00 - 00:05: hoi', 'nl', null);
    assert.strictEqual(artifacts.ok, true, 'empty is not the same as failed');
    assert.deepStrictEqual(artifacts.actionItems, []);
    // Leeg-maar-gelukt MAG wél vervangen: anders blijven verouderde AI-rijen
    // eeuwig staan.
    assert.strictEqual(artifactsUsable(artifacts), true);
});

test('generateSpeakerSummaries keeps only the speakers it was asked about', async () => {
    const transcript = '[Ewald] 00:00 - 00:10: Opening.\n[Tom] 00:10 - 00:30: Agenda.';
    contributionsResponse = JSON.stringify({
        Ewald: 'Ewald opende het overleg en zette de agenda neer.',
        Tom: 'Tom liep de planning door en nam de opvolging op zich.',
        Sandra: 'Sandra was er niet bij.',   // invented — never asked about
        Johan: '   ',                        // empty after trim
    });

    const summaries = await generateSpeakerSummaries(transcript, ['Ewald', 'Tom', 'Johan'], 'nl', null);
    assert.deepStrictEqual(Object.keys(summaries).sort(), ['Ewald', 'Tom']);
    assert.strictEqual(summaries.Ewald, 'Ewald opende het overleg en zette de agenda neer.');

    // The participants are named in the prompt so the model can echo the keys.
    const call = chatCalls.find(c => /THAT PERSON contributed/.test(c.sys));
    assert.match(call.user, /Participants: Ewald, Tom, Johan/);
    // And the prompt must forbid exactly what the chat version produced.
    assert.match(call.sys, /NO bullet points, NO timestamps/);
    assert.strictEqual(call.model, 'smart-model');
});

test('generateSpeakerSummaries caps a runaway summary and survives junk', async () => {
    const transcript = '[Tom] 00:00 - 00:10: Hoi.';
    contributionsResponse = JSON.stringify({ Tom: 'x'.repeat(2000) });
    const capped = await generateSpeakerSummaries(transcript, ['Tom'], 'nl', null);
    assert.strictEqual(capped.Tom.length, 800);

    contributionsResponse = 'sorry, no JSON';
    assert.deepStrictEqual(await generateSpeakerSummaries(transcript, ['Tom'], 'nl', null), {});

    // No speakers or no transcript → no LLM call at all.
    chatCalls.length = 0;
    assert.deepStrictEqual(await generateSpeakerSummaries(transcript, [], 'nl', null), {});
    assert.deepStrictEqual(await generateSpeakerSummaries('', ['Tom'], 'nl', null), {});
    assert.strictEqual(chatCalls.length, 0);
});

test('applySpeakerSummaries merges onto the stat rows without touching the stats', () => {
    const speakers = [
        { id: 'Tom', speakingSeconds: 750, segments: 34 },
        { id: 'Sandra', speakingSeconds: 300, segments: 12 },
    ];
    const merged = applySpeakerSummaries(speakers, { Tom: 'Tom leidde de demo.' });
    assert.deepStrictEqual(merged[0], { id: 'Tom', speakingSeconds: 750, segments: 34, summary: 'Tom leidde de demo.' });
    // A speaker without a summary keeps no empty key…
    assert.ok(!('summary' in merged[1]));
    // …and the input array is never mutated.
    assert.ok(!('summary' in speakers[0]));
    // Nothing to merge → the original rows come straight back.
    assert.strictEqual(applySpeakerSummaries(speakers, {}), speakers);
    assert.strictEqual(applySpeakerSummaries(speakers, null), speakers);
});

test('generateChapters distributes titled chapters evenly when every timestamp is unusable', async () => {
    const transcript = '[X] 00:00 - 00:10: a.\n[Y] 00:20 - 00:30: b.'; // lastEnd 30
    chaptersResponse = JSON.stringify([
        { title: 'Intro', start: 'notatime', summary: 'sa' },
        { title: 'Body', start: 'garbage', summary: 'sb' },
        { title: 'End', start: 9999 }, // past the end → dropped by sanitize
    ]);
    const chapters = await generateChapters(transcript, 'nl', null);
    // The strip must NOT vanish: titled chapters are kept and spaced evenly.
    assert.strictEqual(chapters.length, 3);
    assert.deepStrictEqual(chapters.map(c => c.title), ['Intro', 'Body', 'End']);
    assert.deepStrictEqual(chapters.map(c => c.start), ['00:00', '00:10', '00:20']);
    assert.strictEqual(chapters[0].summary, 'sa');
    assert.strictEqual(chapters[1].summary, 'sb');
    assert.ok(!('summary' in chapters[2]));
});
