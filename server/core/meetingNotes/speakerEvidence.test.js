/**
 * Hybrid PII + LLM speaker evidence.
 * detectPii is injected, so these run with no guard-service and no network.
 *
 * Run: cd server && node --test core/meetingNotes/speakerEvidence.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { extractSpeakerEvidence } = require('./speakerEvidence');
const { renderTranscript } = require('./transcriptExcerpt');
const { formatTime } = require('./transcriptArtifacts');

/**
 * Fake guard: finds each supplied name in the text and returns real spans at
 * real offsets, exactly like the Person tier does.
 */
function fakeDetect(names) {
    return async (text) => {
        const entities = [];
        for (const name of names) {
            let from = 0, at;
            while ((at = text.indexOf(name, from)) !== -1) {
                entities.push({
                    text: name, category: 'Person', label: 'Person Name',
                    confidence: 0.92, offset: at, length: name.length,
                });
                from = at + name.length;
            }
        }
        return { hasPii: entities.length > 0, entities, degraded: false };
    };
}

const SEGMENTS = [
    { speaker: 'speaker_0', start: 0, end: 4, text: 'Zullen we beginnen?' },
    { speaker: 'speaker_2', start: 3153, end: 3157, text: 'Ik ben Ewald.' },
    { speaker: 'speaker_5', start: 3157, end: 3160, text: 'Ik ben Johan.' },
    { speaker: 'speaker_1', start: 3161, end: 3165, text: 'Tom, wat denk jij daarvan?' },
    { speaker: 'speaker_9', start: 3165, end: 3170, text: 'Ik ben benieuwd naar de cijfers.' },
];

function evidenceFor(segments, names) {
    const rendered = renderTranscript(segments, formatTime);
    return extractSpeakerEvidence(segments, rendered, fakeDetect(names));
}

test('attributes each detected name to the speaker whose turn contains it', async () => {
    const ev = await evidenceFor(SEGMENTS, ['Ewald', 'Johan', 'Tom']);
    assert.deepStrictEqual(ev.namesBySpeaker, {
        speaker_2: ['Ewald'],
        speaker_5: ['Johan'],
        speaker_1: ['Tom'],
    });
});

test('builds a roster of every person named anywhere', async () => {
    const ev = await evidenceFor(SEGMENTS, ['Ewald', 'Johan', 'Tom']);
    assert.deepStrictEqual(ev.roster.sort(), ['Ewald', 'Johan', 'Tom']);
});

test('reports name-bearing line indices for the excerpt builder', async () => {
    const ev = await evidenceFor(SEGMENTS, ['Ewald', 'Johan', 'Tom']);
    assert.deepStrictEqual(ev.nameLines, [1, 2, 3]);
});

test('does NOT decide what counts as an introduction — that is the LLM\'s job', async () => {
    // "Tom, wat denk jij?" (address) and "Ik ben Ewald." (introduction) are both
    // just names-in-a-turn here. This module extracts; it does not judge. That
    // distinction is exactly what a pattern list gets wrong.
    const ev = await evidenceFor(SEGMENTS, ['Ewald', 'Tom']);
    assert.deepStrictEqual(ev.namesBySpeaker.speaker_1, ['Tom']);
    assert.deepStrictEqual(ev.namesBySpeaker.speaker_2, ['Ewald']);
    assert.ok(!('introPairs' in ev), 'no intro pre-classification should survive');
});

test('"Ik ben benieuwd" yields no name because NER finds no person there', async () => {
    // No denylist involved: the detector simply never reports "benieuwd".
    const ev = await evidenceFor(SEGMENTS, ['Ewald', 'Johan']);
    assert.ok(!ev.namesBySpeaker.speaker_9);
});

test('offsets map to the right speaker deep into a long transcript', async () => {
    // Guards the offset arithmetic: attributing a name to the wrong speaker is
    // worse than not finding it at all.
    const filler = Array.from({ length: 500 }, (_, i) => ({
        speaker: `speaker_${i % 4}`, start: i * 4, end: i * 4 + 3, text: `Een gewone zin nummer ${i}.`,
    }));
    const segments = [
        ...filler,
        { speaker: 'speaker_77', start: 5400, end: 5404, text: 'Ik ben Ewald.' },
        ...filler.map(s => ({ ...s, start: s.start + 6000, end: s.end + 6000 })),
    ];
    const ev = await evidenceFor(segments, ['Ewald']);

    assert.deepStrictEqual(ev.namesBySpeaker, { speaker_77: ['Ewald'] });
    assert.deepStrictEqual(ev.nameLines, [500]);
});

test('collects multiple distinct names spoken by one id', async () => {
    const segments = [
        { speaker: 'speaker_1', start: 0, end: 4, text: 'Ik ben Tom.' },
        { speaker: 'speaker_1', start: 4, end: 8, text: 'Gerard, kun jij dat oppakken?' },
    ];
    const ev = await evidenceFor(segments, ['Tom', 'Gerard']);
    assert.deepStrictEqual(ev.namesBySpeaker.speaker_1.sort(), ['Gerard', 'Tom']);
});

// ── graceful degradation — the guard is an optional sidecar ──────────

test('returns null when the guard is not configured', async () => {
    const rendered = renderTranscript(SEGMENTS, formatTime);
    assert.strictEqual(await extractSpeakerEvidence(SEGMENTS, rendered, async () => null), null);
});

test('returns null when the guard is installed but unreachable', async () => {
    const rendered = renderTranscript(SEGMENTS, formatTime);
    const ev = await extractSpeakerEvidence(SEGMENTS, rendered, async () => ({
        hasPii: false, entities: [], degraded: true, degradedReason: 'guard_unreachable: ECONNREFUSED',
    }));
    assert.strictEqual(ev, null);
});

test('a throwing detector never breaks the transcription', async () => {
    const rendered = renderTranscript(SEGMENTS, formatTime);
    const ev = await extractSpeakerEvidence(SEGMENTS, rendered, async () => { throw new Error('boom'); });
    assert.strictEqual(ev, null);
});

test('handles empty input and a transcript with no names', async () => {
    assert.strictEqual(await extractSpeakerEvidence([], renderTranscript([], formatTime), fakeDetect(['Tom'])), null);
    assert.strictEqual(await extractSpeakerEvidence(null, null, fakeDetect(['Tom'])), null);

    const ev = await evidenceFor(SEGMENTS, []);
    assert.deepStrictEqual(ev.roster, []);
    assert.deepStrictEqual(ev.namesBySpeaker, {});
});

test('ignores non-Person entities the guard may return', async () => {
    const rendered = renderTranscript(SEGMENTS, formatTime);
    const ev = await extractSpeakerEvidence(SEGMENTS, rendered, async () => ({
        hasPii: true,
        entities: [{ text: 'NL91ABNA0417164300', category: 'Iban', confidence: 0.99, offset: 10, length: 18 }],
        degraded: false,
    }));
    assert.deepStrictEqual(ev.roster, []);
});

// ── the speaker label is not evidence about itself ──────────────────
//
// On the re-identify path the segment labels are already real names, so the
// rendered line reads "[Tom] 00:00 - 00:05: ...". A person-name detector run
// over the whole line finds "Tom" in the PREFIX and records it as "this
// speaker said the name Tom" — circular evidence that confirms whichever label
// is already there and makes a wrong name impossible to correct.

test('names inside the "[Speaker] MM:SS - MM:SS:" prefix are not counted as evidence', async () => {
    const segments = [
        { speaker: 'Tom', start: 0, end: 4, text: 'Zullen we beginnen?' },
        { speaker: 'Tom', start: 4, end: 8, text: 'Ik denk het wel.' },
    ];
    const ev = await evidenceFor(segments, ['Tom']);
    assert.deepStrictEqual(ev.roster, [], 'the label alone is not a mention');
    assert.deepStrictEqual(ev.namesBySpeaker, {});
    assert.deepStrictEqual(ev.nameLines, []);
});

test('the same name IS counted when it is actually spoken', async () => {
    const segments = [
        { speaker: 'Tom', start: 0, end: 4, text: 'Zullen we beginnen?' },
        { speaker: 'speaker_1', start: 4, end: 8, text: 'Ja, Tom, ga je gang.' },
    ];
    const ev = await evidenceFor(segments, ['Tom']);
    assert.deepStrictEqual(ev.roster, ['Tom']);
    assert.deepStrictEqual(ev.namesBySpeaker, { speaker_1: ['Tom'] }, 'only the turn that says it');
    assert.deepStrictEqual(ev.nameLines, [1]);
});
