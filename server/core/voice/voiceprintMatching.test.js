/**
 * Overlap reconciliation between a pyannoteAI /diarize run and a /identify run.
 *
 * The property under test is asymmetric on purpose: a MISSED name costs a
 * "Spreker 2" label, a WRONG name puts words in a named colleague's mouth. So
 * most of these cases assert that the matcher REFUSES, and that the refusal
 * degrades to a roster hint for the LLM rather than to silence.
 *
 * Pure — no DB, no network, no LLM.
 * Run: cd server && node --test core/voice/voiceprintMatching.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { resolveVoiceprintMapping } = require('./voiceprintMatching');

const NAMES = {
    vp_tom: { id: 'vp_tom', name: 'Tom Smit', userId: 'tom' },
    vp_ann: { id: 'vp_ann', name: 'Ann Bakker', userId: 'ann' },
};

/** Identify output where one identify-speaker cleanly matches one label. */
function identifyOutput(rows, confidences) {
    return {
        identification: rows,
        voiceprints: Object.entries(confidences).map(([speaker, [match, confidence]]) => ({
            speaker, match, confidence: { [match]: confidence },
        })),
    };
}

test('a clean, confident, well-covered speaker is pinned', () => {
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 30 }];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 30 }],
        { SPEAKER_A: ['vp_tom', 90] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, { SPEAKER_00: 'Tom Smit' });
    assert.deepStrictEqual(r.roster, []);
    assert.deepStrictEqual(r.matchedIds, ['vp_tom']);
    assert.strictEqual(r.detail[0].decision, 'matched');
});

test('one person split across three diarizer ids pins all three', () => {
    // The diarizer routinely fragments a single voice; every fragment overlaps
    // the same identify speaker, so every fragment gets the same name.
    const diar = [
        { speakerId: 'SPEAKER_00', start: 0, end: 12 },
        { speakerId: 'SPEAKER_02', start: 12, end: 24 },
        { speakerId: 'SPEAKER_05', start: 24, end: 40 },
    ];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 40 }],
        { SPEAKER_A: ['vp_tom', 88] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, { SPEAKER_00: 'Tom Smit', SPEAKER_02: 'Tom Smit', SPEAKER_05: 'Tom Smit' });
});

test('an id the diarizer MERGED from two people is refused, not guessed', () => {
    // Its time is split ~50/50 between two identified speakers, so neither
    // reaches the 60% share floor. Refusing is the only correct answer.
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 40 }];
    const out = identifyOutput(
        [
            { speaker: 'SPEAKER_A', start: 0, end: 20 },
            { speaker: 'SPEAKER_B', start: 20, end: 40 },
        ],
        { SPEAKER_A: ['vp_tom', 85], SPEAKER_B: ['vp_ann', 85] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, {});
    // …but both remain plausible candidates for the LLM naming step.
    assert.deepStrictEqual(r.roster.sort(), ['Ann Bakker', 'Tom Smit']);
    assert.ok(['low_share', 'ambiguous'].includes(r.detail[0].decision));
});

test('a mostly-unidentified speaker is refused on share, not named', () => {
    // 12s of 120s matched — long enough to clear the fragment guard, so this
    // isolates the share floor. Unattributed time counts in the denominator,
    // which is exactly what stops a stranger inheriting a colleague's name.
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 120 }];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 12 }],
        { SPEAKER_A: ['vp_tom', 95] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, {});
    assert.strictEqual(r.detail[0].decision, 'low_share');
    // 10% coverage is not a hint that Tom is present — it is the opposite.
    // (No negative claim either: Tom was pinned nowhere, so nothing is asserted
    // about him in this meeting at all.)
    assert.deepStrictEqual(r.roster, []);
    assert.deepStrictEqual(r.ruledOut, {});
});

test('a genuinely partial overlap still counts as a presence hint', () => {
    // Above ruledOutShare but below minShare: not confident enough to label, but
    // real enough that the LLM should have the name as a candidate.
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 100 }];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 40 }],   // 40%
        { SPEAKER_A: ['vp_tom', 90] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, {});
    assert.deepStrictEqual(r.roster, ['Tom Smit']);
});

test('a two-second brush of overlap is refused as a fragment', () => {
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 60 }];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 2 }],
        { SPEAKER_A: ['vp_tom', 95] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, {});
    assert.strictEqual(r.detail[0].decision, 'too_short');
    assert.deepStrictEqual(r.roster, [], 'two seconds is not evidence that Tom was in the room');
});

test('a short diarization fragment is never named, however confident', () => {
    const diar = [{ speakerId: 'SPEAKER_09', start: 0, end: 5 }];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 5 }],
        { SPEAKER_A: ['vp_tom', 99] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, {});
    assert.strictEqual(r.detail[0].decision, 'too_short');
});

test('confidence below the pin threshold becomes a roster hint, not a label', () => {
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 30 }];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 30 }],
        { SPEAKER_A: ['vp_tom', 45] },   // ≥ weak (35), < pin (60)
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, {});
    assert.deepStrictEqual(r.roster, ['Tom Smit']);
    assert.strictEqual(r.detail[0].decision, 'low_confidence');
});

test('confidence below the weak floor is discarded entirely', () => {
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 30 }];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 30 }],
        { SPEAKER_A: ['vp_tom', 20] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, {});
    assert.deepStrictEqual(r.roster, [], 'a 20%-confidence guess is not even a hint');
});

test('a label we never sent can never become a name', () => {
    // Covers pyannote's no-match sentinels and anything unexpected in `match`.
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 30 }];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 30 }],
        { SPEAKER_A: ['SPEAKER_03', 99] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, {});
    assert.deepStrictEqual(r.roster, []);
});

test('two near-tied candidates are refused as ambiguous', () => {
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 40 }];
    const out = identifyOutput(
        [
            { speaker: 'SPEAKER_A', start: 0, end: 21 },
            { speaker: 'SPEAKER_B', start: 21, end: 40 },
        ],
        { SPEAKER_A: ['vp_tom', 90], SPEAKER_B: ['vp_ann', 90] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, {});
});

test('a per-turn match outranks the speaker-level verdict', () => {
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 30 }];
    const out = {
        identification: [{ speaker: 'SPEAKER_A', match: 'vp_ann', start: 0, end: 30 }],
        voiceprints: [
            { speaker: 'SPEAKER_A', match: 'vp_tom', confidence: { vp_tom: 80 } },
            { speaker: 'SPEAKER_B', match: 'vp_ann', confidence: { vp_ann: 92 } },
        ],
    };
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, { SPEAKER_00: 'Ann Bakker' });
});

test('a pinned name is not repeated as a roster hint', () => {
    const diar = [
        { speakerId: 'SPEAKER_00', start: 0, end: 30 },
        { speakerId: 'SPEAKER_01', start: 30, end: 90 },
    ];
    const out = identifyOutput(
        [
            { speaker: 'SPEAKER_A', start: 0, end: 30 },
            { speaker: 'SPEAKER_A', start: 30, end: 40 },   // weak coverage of SPEAKER_01
        ],
        { SPEAKER_A: ['vp_tom', 90] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, { SPEAKER_00: 'Tom Smit' });
    assert.deepStrictEqual(r.roster, [], 'Tom is already pinned, so he is not also a hint');
});

// ── Negative evidence (ruledOut) ─────────────────────────────────────

test('REGRESSION: the unenrolled participant is ruled out, not absorbed', () => {
    // Rebuilt from a real 1-hour note that came out as ONE speaker. Tom was the
    // only enrolled person; the other participant (SPEAKER_00, ~29 min) was
    // correctly refused at 4% coverage — and then the naming LLM, told only
    // "SPEAKER_01 is Tom", merged them both into Tom.
    const diar = [
        { speakerId: 'SPEAKER_01', start: 0, end: 831 },
        { speakerId: 'SPEAKER_00', start: 831, end: 2553 },
    ];
    const out = identifyOutput(
        [
            { speaker: 'SPEAKER_A', start: 0, end: 831 },
            { speaker: 'SPEAKER_A', start: 831, end: 900 }, // 69s brush = 4% of SPEAKER_00
        ],
        { SPEAKER_A: ['vp_tom', 90] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);

    assert.deepStrictEqual(r.mapping, { SPEAKER_01: 'Tom Smit' });
    assert.deepStrictEqual(r.ruledOut.SPEAKER_00, ['Tom Smit'],
        'the second participant must be positively excluded from being Tom');
    assert.ok(!r.ruledOut.SPEAKER_01, 'the person we actually found is never ruled out');
    assert.deepStrictEqual(r.roster, [],
        'a 4% brush is evidence of ABSENCE — it must not become a candidate name');
});

test('a speaker no identified voice touches at all is ruled out', () => {
    const diar = [
        { speakerId: 'SPEAKER_01', start: 0, end: 60 },
        { speakerId: 'SPEAKER_00', start: 100, end: 200 },   // zero overlap
    ];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 60 }],
        { SPEAKER_A: ['vp_tom', 90] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, { SPEAKER_01: 'Tom Smit' });
    assert.deepStrictEqual(r.ruledOut.SPEAKER_00, ['Tom Smit']);
});

test('the ambiguous band is NOT ruled out — a split voice lives there', () => {
    // 45% coverage: too weak to pin, too strong to deny. The diarizer really
    // does split one person like this, so the LLM keeps the final say.
    const diar = [
        { speakerId: 'SPEAKER_01', start: 0, end: 100 },
        { speakerId: 'SPEAKER_00', start: 100, end: 200 },
    ];
    const out = identifyOutput(
        [
            { speaker: 'SPEAKER_A', start: 0, end: 100 },
            { speaker: 'SPEAKER_A', start: 100, end: 145 },  // 45% of SPEAKER_00
        ],
        { SPEAKER_A: ['vp_tom', 90] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.strictEqual(r.mapping.SPEAKER_01, 'Tom Smit');
    assert.ok(!r.ruledOut.SPEAKER_00, 'a 45% overlap is not grounds to deny');
    assert.deepStrictEqual(r.roster, [], 'nor grounds to assert — Tom is already pinned');
});

test('a name pinned NOWHERE is never ruled out', () => {
    // Ann's template was sent but she was never located. A weak identify run
    // must not be able to BLOCK the LLM from naming her off an introduction.
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 60 }];
    const out = identifyOutput(
        [{ speaker: 'SPEAKER_A', start: 0, end: 60 }],
        { SPEAKER_A: ['vp_tom', 90] },
    );
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.strictEqual(r.mapping.SPEAKER_00, 'Tom Smit');
    assert.deepStrictEqual(Object.values(r.ruledOut).flat().filter(n => n === 'Ann Bakker'), [],
        'Ann was never located, so nothing is claimed about her either way');
});

test('empty / absent identify output degrades to nothing, never throws', () => {
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 30 }];
    for (const out of [null, undefined, {}, { identification: [], voiceprints: [] }]) {
        const r = resolveVoiceprintMapping(diar, out, NAMES);
        assert.deepStrictEqual(r.mapping, {});
        assert.deepStrictEqual(r.roster, []);
    }
    assert.deepStrictEqual(resolveVoiceprintMapping([], { identification: [] }, NAMES).mapping, {});
    assert.deepStrictEqual(resolveVoiceprintMapping(null, null, null).mapping, {});
});

test('a missing confidence value does not block a well-covered match', () => {
    // The identify match score comes back without asking, but the field is
    // optional in the schema — absence must not be read as "zero".
    const diar = [{ speakerId: 'SPEAKER_00', start: 0, end: 30 }];
    const out = {
        identification: [{ speaker: 'SPEAKER_A', start: 0, end: 30 }],
        voiceprints: [{ speaker: 'SPEAKER_A', match: 'vp_tom' }],
    };
    const r = resolveVoiceprintMapping(diar, out, NAMES);
    assert.deepStrictEqual(r.mapping, { SPEAKER_00: 'Tom Smit' });
    assert.strictEqual(r.detail[0].confidence, null);
});
