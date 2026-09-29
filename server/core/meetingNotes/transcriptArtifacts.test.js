/**
 * Pure transcript/diarization shaping.
 *
 * Run: cd server && node --test core/meetingNotes/transcriptArtifacts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    formatTime,
    toContextBias,
    buildTranscriptArtifacts,
    applySpeakerNames,
    fillGenericSpeakerLabels,
    assignSpeakersByOverlap,
    buildPipelineNotices,
    tagSpeakerProvenance,
    parseClock,
    extractTranscriptClocks,
    sanitizeTimestamp,
    artifactsUsable,
    ARTIFACTS_FAILED,
} = require('./transcriptArtifacts');

// ── fillGenericSpeakerLabels ─────────────────────────────────────────

test('fillGenericSpeakerLabels keeps real names and floors unnamed ids to localized labels', () => {
    const speakers = [{ id: 'SPEAKER_00' }, { id: 'SPEAKER_01' }, { id: 'SPEAKER_02' }];
    const mapping = { SPEAKER_00: 'Ewald' }; // only one confidently named
    const out = fillGenericSpeakerLabels(speakers, mapping, 'nl');
    assert.deepStrictEqual(out, { SPEAKER_00: 'Ewald', SPEAKER_01: 'Spreker 1', SPEAKER_02: 'Spreker 2' });
});

test('fillGenericSpeakerLabels numbers generic labels in the order ids are given', () => {
    const out = fillGenericSpeakerLabels(['a', 'b', 'c'], {}, 'en');
    assert.deepStrictEqual(out, { a: 'Speaker 1', b: 'Speaker 2', c: 'Speaker 3' });
});

test('fillGenericSpeakerLabels never leaks a raw diarizer id and defaults to English', () => {
    const out = fillGenericSpeakerLabels([{ id: 'SPEAKER_00' }], null, 'xx');
    assert.strictEqual(out.SPEAKER_00, 'Speaker 1'); // unknown language → English word
    assert.ok(!/SPEAKER_/.test(out.SPEAKER_00));
});

test('fillGenericSpeakerLabels accepts bare id strings and preserves a fully-named mapping', () => {
    const out = fillGenericSpeakerLabels(['s0', 's1'], { s0: 'Tom', s1: 'Gerard' }, 'nl');
    assert.deepStrictEqual(out, { s0: 'Tom', s1: 'Gerard' });
});

// ── toContextBias ────────────────────────────────────────────────────

test('toContextBias splits on commas, semicolons and newlines', () => {
    assert.deepStrictEqual(
        toContextBias('Bee Flow, Kapsule; pgvector\nVoxtral'),
        ['Bee Flow', 'Kapsule', 'pgvector', 'Voxtral'],
    );
});

test('toContextBias drops empties and trims, and tolerates junk input', () => {
    assert.deepStrictEqual(toContextBias('  a ,, ; b  '), ['a', 'b']);
    assert.deepStrictEqual(toContextBias(''), []);
    assert.deepStrictEqual(toContextBias(null), []);
    assert.deepStrictEqual(toContextBias(undefined), []);
});

test('toContextBias caps at the documented 100-phrase API limit', () => {
    const terms = Array.from({ length: 150 }, (_, i) => `term${i}`).join(',');
    const out = toContextBias(terms);
    assert.strictEqual(out.length, 100);
    assert.strictEqual(out[0], 'term0');
    assert.strictEqual(out[99], 'term99');
});

// ── applySpeakerNames ────────────────────────────────────────────────

test('applySpeakerNames maps ids to names', () => {
    const merged = [
        { speaker: 'speaker_0', start: 0, end: 2, text: 'hallo' },
        { speaker: 'speaker_1', start: 2, end: 5, text: 'hoi' },
    ];
    const { speakers, transcript } = applySpeakerNames(merged, { speaker_0: 'Tom', speaker_1: 'Gerard' });

    assert.deepStrictEqual(speakers.map(s => s.id), ['Tom', 'Gerard']);
    assert.ok(transcript.startsWith('[Tom] 00:00 - 00:02: hallo'));
});

test('applySpeakerNames preserves turn boundaries even when ids share a name', () => {
    // Turn boundaries come from the diarizer's acoustics; the name is a
    // text-only LLM guess. Gluing adjacent same-name turns would destroy the
    // boundary whenever that guess is wrong — and the raw segments are never
    // persisted, so it could not be recovered.
    const merged = [
        { speaker: 'speaker_3', start: 0, end: 4, text: 'dus ik denk' },
        { speaker: 'speaker_9', start: 4, end: 7, text: 'dat we moeten wachten' },
    ];
    const out = applySpeakerNames(merged, { speaker_3: 'Ton', speaker_9: 'Ton' });

    assert.strictEqual(out.merged.length, 2);
    assert.deepStrictEqual(out.merged.map(s => s.speaker), ['Ton', 'Ton']);
    assert.strictEqual(out.merged[0].text, 'dus ik denk');
    assert.strictEqual(out.merged[1].text, 'dat we moeten wachten');
});

test('applySpeakerNames never fuses a round of introductions into one turn', () => {
    // The reported regression: four people each saying "Ik ben X" were mapped
    // onto one label and glued into a single row, losing who said what.
    const merged = [
        { speaker: 'speaker_2', start: 0, end: 2, text: 'Ik ben Ewald.' },
        { speaker: 'speaker_5', start: 2, end: 4, text: 'Ik ben Johan.' },
        { speaker: 'speaker_8', start: 4, end: 6, text: 'Ik ben Tom.' },
    ];
    // Even under a mapping that wrongly collapses all three onto one person,
    // the three turns must survive as three rows.
    const out = applySpeakerNames(merged, { speaker_2: 'B', speaker_5: 'B', speaker_8: 'B' });

    assert.strictEqual(out.merged.length, 3);
    assert.deepStrictEqual(out.merged.map(s => s.text), ['Ik ben Ewald.', 'Ik ben Johan.', 'Ik ben Tom.']);
    // The roster still collapses to one row — summing durations loses nothing.
    assert.strictEqual(out.speakers.length, 1);
    assert.strictEqual(out.speakers[0].speakingSeconds, 6);
});

test('applySpeakerNames folds duplicate stats rows and sums their speaking time', () => {
    // Non-adjacent fragments of one person must still produce ONE row whose
    // duration is the sum — not three rows splitting it.
    const merged = [
        { speaker: 'speaker_0', start: 0, end: 10, text: 'a' },
        { speaker: 'speaker_5', start: 10, end: 12, text: 'b' },
        { speaker: 'speaker_0', start: 12, end: 20, text: 'c' },
    ];
    const { speakers } = applySpeakerNames(merged, { speaker_0: 'Ton', speaker_5: 'Ton' });

    assert.strictEqual(speakers.length, 1);
    assert.strictEqual(speakers[0].id, 'Ton');
    assert.strictEqual(speakers[0].speakingSeconds, 20);
    assert.strictEqual(speakers[0].speakingTime, '00:20');
    // One roster row, but the three turns are still counted as three.
    assert.strictEqual(speakers[0].segments, 3);
});

test('applySpeakerNames collapses an over-segmented meeting to its real roster', () => {
    // The reported failure: a long meeting came back with a tail of 2-second
    // phantom ids. Once the model maps them onto the real people, the roster
    // must shrink to those people.
    const merged = [
        { speaker: 'speaker_0', start: 0, end: 600, text: 'lang verhaal' },
        { speaker: 'speaker_7', start: 600, end: 602, text: 'ja' },
        { speaker: 'speaker_1', start: 602, end: 900, text: 'antwoord' },
        { speaker: 'speaker_12', start: 900, end: 902, text: 'precies' },
    ];
    const { speakers } = applySpeakerNames(merged, {
        speaker_0: 'Ton', speaker_7: 'Ton', speaker_1: 'Gerard', speaker_12: 'Gerard',
    });

    assert.strictEqual(speakers.length, 2);
    assert.deepStrictEqual(speakers.map(s => s.id).sort(), ['Gerard', 'Ton']);
    assert.strictEqual(speakers.find(s => s.id === 'Ton').speakingSeconds, 602);
    assert.strictEqual(speakers.find(s => s.id === 'Gerard').speakingSeconds, 300);
});

test('applySpeakerNames leaves unmapped ids untouched', () => {
    const merged = [
        { speaker: 'speaker_0', start: 0, end: 2, text: 'a' },
        { speaker: 'speaker_4', start: 2, end: 4, text: 'b' },
    ];
    const { speakers } = applySpeakerNames(merged, { speaker_0: 'Tom' });
    assert.deepStrictEqual(speakers.map(s => s.id), ['Tom', 'speaker_4']);
});

test('applySpeakerNames with a null mapping still merges and stats correctly', () => {
    const merged = [{ speaker: 'speaker_0', start: 0, end: 3, text: 'a' }];
    const out = applySpeakerNames(merged, null);
    assert.strictEqual(out.merged.length, 1);
    assert.strictEqual(out.speakers[0].id, 'speaker_0');
    assert.strictEqual(out.speakers[0].speakingSeconds, 3);
});

test('applySpeakerNames does not mutate its input', () => {
    const merged = [
        { speaker: 'speaker_0', start: 0, end: 2, text: 'a' },
        { speaker: 'speaker_1', start: 2, end: 4, text: 'b' },
    ];
    applySpeakerNames(merged, { speaker_0: 'Tom', speaker_1: 'Tom' });
    assert.deepStrictEqual(merged.map(s => s.speaker), ['speaker_0', 'speaker_1']);
    assert.strictEqual(merged.length, 2);
});

test('applySpeakerNames handles empty and missing input', () => {
    assert.deepStrictEqual(applySpeakerNames([], null), { merged: [], transcript: '', speakers: [] });
    assert.deepStrictEqual(applySpeakerNames(null, null), { merged: [], transcript: '', speakers: [] });
});

// ── formatTime / buildTranscriptArtifacts ────────────────────────────

test('formatTime switches to HH:MM:SS past an hour', () => {
    assert.strictEqual(formatTime(0), '00:00');
    assert.strictEqual(formatTime(65), '01:05');
    assert.strictEqual(formatTime(3661), '01:01:01');
    assert.strictEqual(formatTime(null), '00:00');
});

test('buildTranscriptArtifacts merges consecutive same-speaker segments', () => {
    const { merged, speakers, totalDuration } = buildTranscriptArtifacts([
        { speakerId: 'speaker_0', start: 0, end: 2, text: 'hallo' },
        { speakerId: 'speaker_0', start: 2, end: 4, text: 'daar' },
        { speakerId: 'speaker_1', start: 4, end: 9, text: 'hoi' },
    ]);
    assert.strictEqual(merged.length, 2);
    assert.strictEqual(merged[0].text, 'hallo daar');
    assert.strictEqual(totalDuration, 9);
    assert.strictEqual(speakers.length, 2);
});

// ── assignSpeakersByOverlap (hybrid: cloud transcript + local diarizer) ──

test('assignSpeakersByOverlap assigns the max-overlap speaker per segment', () => {
    const segments = [
        { start: 0, end: 3, text: 'a' },   // fully inside speaker_00
        { start: 5, end: 9, text: 'b' },   // fully inside speaker_01
    ];
    const turns = [
        { start: 0, end: 4, speaker: 'speaker_00' },
        { start: 4, end: 10, speaker: 'speaker_01' },
    ];
    const out = assignSpeakersByOverlap(segments, turns);
    assert.strictEqual(out[0].speakerId, 'speaker_00');
    assert.strictEqual(out[1].speakerId, 'speaker_01');
    assert.strictEqual(out[0].text, 'a'); // original fields preserved
});

test('assignSpeakersByOverlap picks the speaker with the greatest summed overlap', () => {
    // Segment [2,10] overlaps speaker_00 for 1s ([2,3]) and speaker_01 for 7s ([3,10]).
    const out = assignSpeakersByOverlap(
        [{ start: 2, end: 10, text: 'x' }],
        [
            { start: 0, end: 3, speaker: 'speaker_00' },
            { start: 3, end: 12, speaker: 'speaker_01' },
        ],
    );
    assert.strictEqual(out[0].speakerId, 'speaker_01');
});

test('assignSpeakersByOverlap sums a speaker split across several turns', () => {
    // speaker_00 turns total 4s of overlap vs speaker_01's single 3s turn.
    const out = assignSpeakersByOverlap(
        [{ start: 0, end: 10, text: 'x' }],
        [
            { start: 0, end: 2, speaker: 'speaker_00' },
            { start: 4, end: 7, speaker: 'speaker_01' },
            { start: 7, end: 9, speaker: 'speaker_00' },
        ],
    );
    assert.strictEqual(out[0].speakerId, 'speaker_00');
});

test('assignSpeakersByOverlap falls back when no turn overlaps', () => {
    const out = assignSpeakersByOverlap(
        [{ start: 20, end: 25, text: 'x' }],
        [{ start: 0, end: 5, speaker: 'speaker_00' }],
    );
    assert.strictEqual(out[0].speakerId, 'speaker_0');
    const out2 = assignSpeakersByOverlap([{ start: 20, end: 25 }], [], 'unknown');
    assert.strictEqual(out2[0].speakerId, 'unknown');
});

test('assignSpeakersByOverlap tolerates empty/junk input', () => {
    assert.deepStrictEqual(assignSpeakersByOverlap([], []), []);
    assert.deepStrictEqual(assignSpeakersByOverlap(null, null), []);
    // touching-but-not-overlapping turn (inter === 0) does not count
    const out = assignSpeakersByOverlap(
        [{ start: 5, end: 10, text: 'x' }],
        [{ start: 0, end: 5, speaker: 'speaker_00' }],
    );
    assert.strictEqual(out[0].speakerId, 'speaker_0');
});

// ── parseClock / extractTranscriptClocks ─────────────────────────────

test('parseClock reads MM:SS and HH:MM:SS, rejects junk', () => {
    assert.strictEqual(parseClock('05:30'), 330);
    assert.strictEqual(parseClock('01:05:30'), 3930);
    assert.strictEqual(parseClock(' 12:10 '), 730);
    assert.strictEqual(parseClock('n/a'), null);
    assert.strictEqual(parseClock(''), null);
    assert.strictEqual(parseClock(null), null);
    assert.strictEqual(parseClock('12:99'), null);
});

test('extractTranscriptClocks collects line starts and the last end stamp', () => {
    const transcript = [
        '[Ton] 00:05 - 00:12: Welkom allemaal.',
        '[Gerard] 00:12 - 01:02: Dank je.',
        '[Ton] 01:05:20 - 01:06:00: Tot volgende week.',
    ].join('\n');
    const clocks = extractTranscriptClocks(transcript);
    assert.deepStrictEqual(clocks.starts, [5, 12, 3920]);
    assert.strictEqual(clocks.lastEnd, 3960);
});

// ── sanitizeTimestamp (the phantom-marker rule, server side) ─────────

const CLOCKS_LONG = { starts: [5, 330, 3930, 5400], lastEnd: 6000 }; // 100-min meeting

test('sanitizeTimestamp drops junk and out-of-range stamps', () => {
    assert.strictEqual(sanitizeTimestamp('n/a', CLOCKS_LONG), '');
    assert.strictEqual(sanitizeTimestamp('', CLOCKS_LONG), '');
    assert.strictEqual(sanitizeTimestamp(undefined, CLOCKS_LONG), '');
    // 02:30:00 = 9000s > lastEnd 6000s → junk
    assert.strictEqual(sanitizeTimestamp('02:30:00', CLOCKS_LONG), '');
});

test('sanitizeTimestamp keeps stamps that match real lines', () => {
    assert.strictEqual(sanitizeTimestamp('05:30', CLOCKS_LONG), '05:30');
    assert.strictEqual(sanitizeTimestamp('01:05:30', CLOCKS_LONG), '01:05:30');
});

test('sanitizeTimestamp repairs hour-truncated stamps in >1h meetings', () => {
    // "05:30" near a real line (330s) stays as-is, but "30:00" (1800s) matches
    // no line while 01:30:00 (5400s) does → repaired to the hour variant.
    assert.strictEqual(sanitizeTimestamp('30:00', CLOCKS_LONG), '01:30:00');
});

test('sanitizeTimestamp leaves short meetings and unknown context alone', () => {
    const shortClocks = { starts: [5, 330], lastEnd: 900 };
    assert.strictEqual(sanitizeTimestamp('05:30', shortClocks), '05:30');
    // No clocks known → can't validate, keep parsable stamps.
    assert.strictEqual(sanitizeTimestamp('05:30', { starts: [], lastEnd: 0 }), '05:30');
    assert.strictEqual(sanitizeTimestamp('garbage', { starts: [], lastEnd: 0 }), '');
});

test('sanitizeTimestamp accepts a numeric seconds value (number or bare string)', () => {
    // The LLM sometimes returns `"start": 750` instead of "12:30" — treat a bare
    // number as seconds so the chapter/action item is not dropped.
    assert.strictEqual(sanitizeTimestamp(0, CLOCKS_LONG), '00:00');
    assert.strictEqual(sanitizeTimestamp(750, CLOCKS_LONG), '12:30');
    assert.strictEqual(sanitizeTimestamp('750', CLOCKS_LONG), '12:30');
    assert.strictEqual(sanitizeTimestamp(3930, CLOCKS_LONG), '01:05:30'); // past the hour
    assert.strictEqual(sanitizeTimestamp('0', CLOCKS_LONG), '00:00');
    // Out of range and negative → dropped.
    assert.strictEqual(sanitizeTimestamp(9000, CLOCKS_LONG), ''); // > lastEnd 6000
    assert.strictEqual(sanitizeTimestamp(-5, CLOCKS_LONG), '');
    // A number with no clock context is still accepted (kept parsable).
    assert.strictEqual(sanitizeTimestamp(90, { starts: [], lastEnd: 0 }), '01:30');
});

// ── merge caps ───────────────────────────────────────────────────────

test('a long single-speaker recording stays navigable', () => {
    // Regression: with no caps, a solo dictation (or any run where diarization
    // degraded to one label) collapsed into ONE segment spanning the meeting.
    // segment_count was 1, and every timestamp in the transcript seeked to 0:00.
    const segments = Array.from({ length: 40 }, (_, i) => ({
        speakerId: 'speaker_0', start: i * 10, end: (i * 10) + 10, text: `zin ${i}`,
    }));
    const { merged, speakers } = buildTranscriptArtifacts(segments);

    assert.ok(merged.length > 1, `expected multiple turns, got ${merged.length}`);
    assert.ok(merged.every(m => (m.end - m.start) <= 70), 'no turn may run away in length');
    // Still one person — the caps split turns, they do not invent speakers.
    assert.strictEqual(speakers.length, 1);
    assert.strictEqual(speakers[0].id, 'speaker_0');
    // Timestamps stay distinct, so clicking a line seeks somewhere real.
    assert.strictEqual(new Set(merged.map(m => m.start)).size, merged.length);
});

test('a real pause ends a turn', () => {
    const { merged } = buildTranscriptArtifacts([
        { speakerId: 's0', start: 0, end: 5, text: 'eerste' },
        { speakerId: 's0', start: 30, end: 35, text: 'na een lange stilte' },
    ]);
    assert.strictEqual(merged.length, 2, 'a 25-second gap is a boundary, not a continuation');
});

test('consecutive same-speaker segments still merge when they are close', () => {
    // The original behaviour, unchanged for the normal case.
    const { merged } = buildTranscriptArtifacts([
        { speakerId: 's0', start: 0, end: 3, text: 'hallo' },
        { speakerId: 's0', start: 3, end: 6, text: 'allemaal' },
        { speakerId: 's1', start: 6, end: 9, text: 'hoi' },
    ]);
    assert.strictEqual(merged.length, 2);
    assert.strictEqual(merged[0].text, 'hallo allemaal');
});

// ── buildPipelineNotices ─────────────────────────────────────────────

test('buildPipelineNotices renders fallback + truncation lines per language', () => {
    const nl = buildPipelineNotices({
        providerFallback: { to: 'voxtral' },
        truncated: { atSeconds: 3930 },
        language: 'nl',
    });
    assert.strictEqual(nl.length, 2);
    assert.match(nl[0], /Voxtral/);
    assert.match(nl[1], /01:05:30/);
    assert.match(nl[1], /voortijdig gestopt/);

    const en = buildPipelineNotices({ truncated: { atSeconds: 90 }, language: 'en' });
    assert.strictEqual(en.length, 1);
    assert.match(en[0], /stopped early at 01:30/);
});

test('buildPipelineNotices is empty when nothing happened', () => {
    assert.deepStrictEqual(buildPipelineNotices({ language: 'nl' }), []);
    assert.deepStrictEqual(buildPipelineNotices(), []);
});

test('a SUCCESSFUL voiceprint match produces no notice — the names are the notice', () => {
    const info = { matched: 2, considered: 5, truncated: false, failed: false, detail: [] };
    assert.deepStrictEqual(buildPipelineNotices({ voiceprint: info, language: 'nl' }), []);
});

test('buildPipelineNotices explains a failed or capped voiceprint run', () => {
    const failedNl = buildPipelineNotices({ voiceprint: { failed: true }, language: 'nl' });
    assert.strictEqual(failedNl.length, 1);
    assert.match(failedNl[0], /stemherkenning is niet gelukt/);

    const failedEn = buildPipelineNotices({ voiceprint: { failed: true }, language: 'en' });
    assert.match(failedEn[0], /voice recognition failed/);

    const cappedNl = buildPipelineNotices({ voiceprint: { truncated: true }, language: 'nl' });
    assert.match(cappedNl[0], /meer dan 50 stemprofielen/);

    const cappedEn = buildPipelineNotices({ voiceprint: { truncated: true }, language: 'en' });
    assert.match(cappedEn[0], /more than 50 voice profiles/);
});

test('tagSpeakerProvenance marks only the voice-matched rows, leaving the rest untouched', () => {
    const speakers = [{ id: 'Tom Smit', speakingSeconds: 40 }, { id: 'Spreker 2', speakingSeconds: 12 }];
    const out = tagSpeakerProvenance(speakers, { SPEAKER_00: 'Tom Smit' });
    assert.strictEqual(out[0].source, 'voiceprint');
    assert.ok(!('source' in out[1]), 'an LLM-derived row keeps the shape it always had');

    // No matches → the array is returned as-is, so a note with no voiceprints
    // is byte-identical to one from before the feature existed.
    const untouched = [{ id: 'Spreker 1' }];
    assert.strictEqual(tagSpeakerProvenance(untouched, null), untouched);
    assert.strictEqual(tagSpeakerProvenance(untouched, {}), untouched);
});

// ── gap segments (a failed Scaleway chunk) ──────────────────────────
//
// A chunk that exhausts its retries contributes a placeholder covering its
// whole 10-minute range. Counting that as speech gave whoever it was attributed
// to ten fabricated minutes of airtime and inflated the meeting duration.

test('gap segments are not charged to any speaker', () => {
    const { speakers } = buildTranscriptArtifacts([
        { speakerId: 'speaker_0', start: 0, end: 30, text: 'hallo' },
        { speakerId: 'speaker_0', start: 600, end: 1200, text: '[audio section could not be transcribed]', gap: true },
        { speakerId: 'speaker_1', start: 1200, end: 1230, text: 'hoi' },
    ]);
    const s0 = speakers.find(s => s.id === 'speaker_0');
    const s1 = speakers.find(s => s.id === 'speaker_1');
    assert.strictEqual(s0.speakingSeconds, 30, 'the 600s hole is not speaking time');
    assert.strictEqual(s0.segments, 1);
    assert.strictEqual(s1.speakingSeconds, 30);
});

test('a gap is never merged into an adjacent turn by the same speaker', () => {
    const { merged } = buildTranscriptArtifacts([
        { speakerId: 'speaker_0', start: 0, end: 10, text: 'hallo' },
        { speakerId: 'speaker_0', start: 10, end: 610, text: '[audio section could not be transcribed]', gap: true },
        { speakerId: 'speaker_0', start: 610, end: 620, text: 'weer terug' },
    ]);
    assert.strictEqual(merged.length, 3, 'the hole stays its own segment');
    assert.strictEqual(merged[1].gap, true);
    assert.strictEqual(merged[0].text, 'hallo');
    assert.strictEqual(merged[2].text, 'weer terug');
});

test('assignSpeakersByOverlap leaves gap segments unattributed', () => {
    const out = assignSpeakersByOverlap(
        [{ start: 0, end: 600, text: '[audio section could not be transcribed]', gap: true }],
        [{ start: 0, end: 5, speaker: 'SPEAKER_01' }],
    );
    assert.strictEqual(out[0].speakerId, 'speaker_0', 'the 5s of overlap must not claim 600s');
});

// ── DRIE UITKOMSTEN, DRIE WAARDEN ────────────────────────────────────
//
// Een artefactpass kan drie dingen doen: iets vinden, niets vinden, of niet
// draaien. De eerste twee mogen bestaande actiepunten/besluiten/vragen
// vervangen, de derde niet. Dat verschil zat in een LOSSE VLAG (`ok`) naast
// vier lege lijsten — en een vlag naast een lijst is precies wat een schrijver
// vergeet: twee van de vier schrijvers (upload.js, ingestRecordingCore.js)
// deden dat ook, en zes testfixtures ook.
//
// Nu draagt de WAARDE zelf het onderscheid: een geslaagde pass HEEFT de vier
// lijsten, een mislukte pass heeft ze NIET. `artifactsUsable` is de ene vraag
// die elke schrijver stelt, en onbekend versmalt daar — geen lijsten betekent
// niets om mee te schrijven, nooit "de vergadering was leeg".

test('a failed pass carries NO artifact lists at all — the value is the difference', () => {
    // Geen `actionItems: []` om per ongeluk overheen te schrijven: wie de
    // lijsten van een mislukte pass doorgeeft aan updateTranscription geeft
    // `undefined` door, en dat betekent daar "deze kolom niet aanraken".
    assert.strictEqual(ARTIFACTS_FAILED.ok, false);
    assert.strictEqual(ARTIFACTS_FAILED.actionItems, undefined);
    assert.strictEqual(ARTIFACTS_FAILED.decisions, undefined);
    assert.strictEqual(ARTIFACTS_FAILED.questions, undefined);
    assert.strictEqual(ARTIFACTS_FAILED.tags, undefined);
    // Eén gedeelde waarde die niemand per ongeluk kan aanpassen.
    assert.ok(Object.isFrozen(ARTIFACTS_FAILED));
});

test('artifactsUsable says yes to a pass with results AND to a genuinely empty one', () => {
    assert.strictEqual(artifactsUsable({
        actionItems: [{ id: 'ai-0', text: 'Bellen' }], decisions: [], questions: [], tags: ['planning'], ok: true,
    }), true);
    // "In deze vergadering is niets afgesproken" is een GESLAAGDE pass en moet
    // de oude AI-rijen wél opruimen — anders blijven verouderde actiepunten
    // eeuwig staan.
    assert.strictEqual(artifactsUsable({ actionItems: [], decisions: [], questions: [], tags: [], ok: true }), true);
    // Back-compat: een fixture/oude aanroeper zonder `ok` maar mét de vier
    // lijsten is een geslaagde pass, precies zoals voorheen.
    assert.strictEqual(artifactsUsable({ actionItems: [], decisions: [], questions: [], tags: [] }), true);
});

test('artifactsUsable narrows on everything it does not recognise as a finished pass', () => {
    assert.strictEqual(artifactsUsable(ARTIFACTS_FAILED), false);
    // Onbekend VERSMALT. `ok !== false` liet al deze vormen door als "gelukt",
    // waarna de merge elke opgeslagen AI-rij verving door niets.
    assert.strictEqual(artifactsUsable({}), false, 'een antwoord zonder lijsten is geen lege vergadering');
    assert.strictEqual(artifactsUsable(null), false);
    assert.strictEqual(artifactsUsable(undefined), false);
    assert.strictEqual(artifactsUsable({ ok: true }), false, 'ok:true zonder lijsten blijft onbruikbaar');
    assert.strictEqual(artifactsUsable({ actionItems: [], decisions: [], tags: [] }), false, 'questions ontbreekt');
    assert.strictEqual(artifactsUsable({ actionItems: 'geen lijst', decisions: [], questions: [], tags: [] }), false);
    // De vlag mag nog steeds nee zeggen, ook als de lijsten er wél zijn.
    assert.strictEqual(artifactsUsable({ actionItems: [], decisions: [], questions: [], tags: [], ok: false }), false);
});

test('buildPipelineNotices says on screen that the artifacts could not be extracted', () => {
    const nl = buildPipelineNotices({ artifactsFailed: true, language: 'nl' });
    assert.strictEqual(nl.length, 1);
    assert.match(nl[0], /actiepunten/i);
    // Het moet zeggen dat er NIETS is weggegooid — anders leest een lege lijst
    // als "er is niets afgesproken".
    assert.match(nl[0], /niet gelukt|mislukt/i);

    const en = buildPipelineNotices({ artifactsFailed: true, language: 'en' });
    assert.strictEqual(en.length, 1);
    assert.match(en[0], /action items/i);

    // Een GESLAAGDE pass zegt niets — de lijsten zijn zelf het bericht.
    assert.deepStrictEqual(buildPipelineNotices({ artifactsFailed: false, language: 'nl' }), []);
});
