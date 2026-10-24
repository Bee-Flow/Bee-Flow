/**
 * speakerNaming — speaker naming (guard-free).
 *
 * Pins the fixes for pyannote speakers coming back as generic "SPEAKER_00":
 *  - naming runs on the SMART tier (not the weak fast tier);
 *  - with no attendee roster and no PII guard, an LLM extraction pass supplies
 *    the candidate roster (introduced names), so naming still works;
 *  - the model may omit ids it can't name, and any generic label it emits is
 *    dropped — those ids get a clean floor label from fillGenericSpeakerLabels.
 *
 * llmClient / speakerEvidence / piiDetection / modelResolver are require-cache
 * stubbed — no DB, no real LLM. Run:
 *   cd server && node --test core/meetingNotes/speakerNaming.test.js
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
            // A fallen-over smart tier (time-out, 500, no model): the third outcome, and the only
            // one that must not be allowed to wipe anything.
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


const { identifySpeakerNames } = require('./speakerNaming');
const { fillGenericSpeakerLabels, applySpeakerNames } = require('./transcriptArtifacts');

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
