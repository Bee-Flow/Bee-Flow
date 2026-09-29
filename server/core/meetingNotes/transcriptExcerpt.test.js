/**
 * Run: cd server && node --test core/meetingNotes/transcriptExcerpt.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    renderTranscript,
    buildSpeakerNamingExcerpt,
    GAP_MARKER,
} = require('./transcriptExcerpt');
const { formatTime } = require('./transcriptArtifacts');

/** Seconds from an `HH:MM:SS` or `MM:SS` stamp. */
function toSeconds(stamp) {
    const parts = stamp.split(':').map(Number);
    return parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
}

/**
 * Segments shaped like the real failing meeting: ~100 minutes at ~1,540
 * chars/minute, i.e. comfortably past the 60k budget.
 */
function buildLongMeeting() {
    const filler = 'Dit is een wat langere zin uit het gesprek die ongeveer de gemiddelde lengte heeft van een beurt.';
    return Array.from({ length: 1600 }, (_, i) => ({
        speaker: `speaker_${i % 6}`,
        start: i * 4,
        end: i * 4 + 3,
        text: `${filler} (${i})`,
    }));
}

function excerptOf(segments, opts) {
    const { lines } = renderTranscript(segments, formatTime);
    return buildSpeakerNamingExcerpt(segments, lines, opts);
}

// ── renderTranscript ─────────────────────────────────────────────────

test('renderTranscript formats lines and records exact char ranges', () => {
    const segments = [
        { speaker: 'speaker_0', start: 0, end: 4, text: 'hallo' },
        { speaker: 'speaker_1', start: 4, end: 9, text: 'hoi' },
    ];
    const { text, offsets, lines } = renderTranscript(segments, formatTime);

    assert.strictEqual(lines[0], '[speaker_0] 00:00 - 00:04: hallo');
    assert.strictEqual(text, lines.join('\n'));
    // The offsets must index the joined text exactly — this is what lets NER
    // spans be attributed to a speaker without any parsing.
    assert.strictEqual(text.slice(offsets[0].start, offsets[0].end), lines[0]);
    assert.strictEqual(text.slice(offsets[1].start, offsets[1].end), lines[1]);
});

test('renderTranscript uses HH:MM:SS past an hour and tolerates junk input', () => {
    const { lines } = renderTranscript([{ speaker: 'x', start: 3661, end: 3665, text: 'laat' }], formatTime);
    assert.strictEqual(lines[0], '[x] 01:01:01 - 01:01:05: laat');
    assert.deepStrictEqual(renderTranscript([], formatTime).lines, []);
    assert.deepStrictEqual(renderTranscript(null, formatTime).offsets, []);
});

// ── buildSpeakerNamingExcerpt ────────────────────────────────────────

test('a transcript within budget is returned verbatim', () => {
    const segments = [
        { speaker: 'speaker_0', start: 0, end: 4, text: 'hallo' },
        { speaker: 'speaker_1', start: 4, end: 9, text: 'hoi' },
    ];
    const { lines } = renderTranscript(segments, formatTime);
    const { excerpt, stats } = buildSpeakerNamingExcerpt(segments, lines);

    assert.strictEqual(excerpt, lines.join('\n'));
    assert.strictEqual(stats.truncated, false);
    assert.ok(!excerpt.includes(GAP_MARKER));
});

test('REGRESSION: a named line past the old 60k prefix survives', () => {
    // The reported bug: the old code sent substring(0, 60000) — ~39 minutes —
    // so an introduction at 52:33 never reached the model and Ewald came back
    // as "Speaker A".
    const segments = buildLongMeeting();
    const introIdx = 790; // ~52:40 at 4s/segment
    segments[introIdx] = { speaker: 'speaker_4', start: 52 * 60 + 33, end: 52 * 60 + 37, text: 'Ik ben Ewald.' };

    const { lines, text } = renderTranscript(segments, formatTime);
    assert.ok(
        !text.substring(0, 60000).includes('Ik ben Ewald.'),
        'fixture must place the name beyond the old 60k prefix',
    );

    const { excerpt, stats } = buildSpeakerNamingExcerpt(segments, lines, { nameLines: [introIdx] });

    assert.ok(excerpt.includes('Ik ben Ewald.'), 'name-bearing line must survive into the excerpt');
    assert.ok(excerpt.length <= 60000, 'must respect the budget');
    assert.strictEqual(stats.truncated, true);
});

test('the excerpt reaches the end of the meeting, not just the opening', () => {
    const segments = buildLongMeeting();
    segments[1599] = { speaker: 'speaker_5', start: 99 * 60, end: 99 * 60 + 4, text: 'LAATSTE_BEURT_MARKER' };
    assert.ok(excerptOf(segments).excerpt.includes('LAATSTE_BEURT_MARKER'));
});

test('a rare speaker with one late turn is covered', () => {
    const segments = buildLongMeeting();
    segments[1400] = { speaker: 'speaker_rare', start: 93 * 60, end: 93 * 60 + 4, text: 'ZELDZAME_SPREKER_MARKER' };

    const { excerpt, stats } = excerptOf(segments);
    assert.ok(excerpt.includes('ZELDZAME_SPREKER_MARKER'), 'rare ids are why "Speaker A" happens');
    assert.strictEqual(stats.speakersCovered, stats.speakersTotal);
});

test('name-bearing lines pull in their neighbours for context', () => {
    const segments = buildLongMeeting();
    segments[900] = { speaker: 'speaker_1', start: 3600, end: 3604, text: 'Tom, wat denk jij?' };
    segments[901] = { speaker: 'speaker_2', start: 3604, end: 3608, text: 'ANTWOORD_VAN_TOM_MARKER' };

    const { excerpt } = excerptOf(segments, { maxChars: 20000, nameLines: [900] });
    assert.ok(excerpt.includes('Tom, wat denk jij?'));
    // The reply is what identifies Tom — the address alone proves nothing.
    assert.ok(excerpt.includes('ANTWOORD_VAN_TOM_MARKER'));
});

test('gaps are marked, and never doubled or left dangling', () => {
    const { excerpt } = excerptOf(buildLongMeeting(), { maxChars: 12000 });

    assert.ok(excerpt.includes(GAP_MARKER), 'a truncated excerpt must mark its gaps');
    assert.ok(!excerpt.includes(`${GAP_MARKER}\n${GAP_MARKER}`), 'no doubled markers');
    assert.ok(!excerpt.startsWith(GAP_MARKER), 'no leading marker');
    assert.ok(!excerpt.endsWith(GAP_MARKER), 'no trailing marker');
});

test('every kept line keeps its speaker prefix and order stays chronological', () => {
    const { excerpt } = excerptOf(buildLongMeeting(), { maxChars: 20000 });
    const kept = excerpt.split('\n').filter(l => l !== GAP_MARKER);

    for (const l of kept) {
        assert.match(l, /^\[speaker_\S+\] [\d:]+ - [\d:]+: /, `orphaned line: ${l}`);
    }
    const seconds = kept.map(l => toSeconds(l.match(/\] ([\d:]+) -/)[1]));
    for (let i = 1; i < seconds.length; i++) {
        assert.ok(seconds[i] >= seconds[i - 1], 'excerpt must stay chronological');
    }
});

test('the budget is respected across a range of sizes', () => {
    const segments = buildLongMeeting();
    for (const maxChars of [5000, 20000, 60000, 100000]) {
        const { excerpt } = excerptOf(segments, { maxChars });
        assert.ok(excerpt.length <= maxChars, `overflowed at maxChars=${maxChars}`);
    }
});

test('handles empty and missing input', () => {
    assert.strictEqual(buildSpeakerNamingExcerpt([], []).excerpt, '');
    assert.strictEqual(buildSpeakerNamingExcerpt(null, null).excerpt, '');
});

test('out-of-range name indices are ignored rather than throwing', () => {
    const { excerpt } = excerptOf(buildLongMeeting(), { maxChars: 20000, nameLines: [-5, 999999] });
    assert.ok(excerpt.length > 0 && excerpt.length <= 20000);
});
