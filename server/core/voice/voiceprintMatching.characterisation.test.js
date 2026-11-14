// @typecheck
/**
 * Characterisation (golden) test for resolveVoiceprintMapping: the whole
 * result (mapping, roster, ruledOut, matchedIds and every detail row with its
 * rounding) for meetings that reach the branches the behaviour tests in
 * voiceprintMatching.test.js leave implicit: the best confidence per label
 * over several identify speakers, a missing score next to a real one, the
 * diarizationSpeaker key, malformed and zero-length turns, string times, two
 * labels for one person, a person without a voiceprint id, a speaker count
 * with a single pin, three pins of which two talk over each other, and
 * option overrides.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/voice/voiceprintMatching.characterisation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveVoiceprintMapping } = require('./voiceprintMatching');

const GOLDEN = path.join(__dirname, 'voiceprintMatching.characterisation.golden.json');

const NAMES = {
    vp_tom: { id: 'vp_tom', name: 'Tom Smit', userId: 'tom' },
    vp_tom2: { id: 'vp_tom2', name: 'Tom Smit', userId: 'tom' },
    vp_ann: { id: 'vp_ann', name: 'Ann Bakker', userId: 'ann' },
    vp_bob: { name: 'Bob de Vries' },
};

/** @type {Record<string, () => unknown>} */
const CASES = {
    roundedDetail: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 33.333 }, { speakerId: 'S1', start: 33.333, end: 70.07 }],
        {
            identification: [{ speaker: 'A', start: 0, end: 31.26 }, { speaker: 'B', start: 33.4, end: 70.07 }],
            voiceprints: [{ speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 77.7 } }, { speaker: 'B', match: 'vp_ann', confidence: { vp_ann: 61 } }],
        },
        NAMES,
    ),
    bestConfidencePerLabel: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 40 }],
        {
            identification: [{ speaker: 'A', start: 0, end: 20 }, { speaker: 'B', start: 20, end: 40 }],
            voiceprints: [
                { speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 50 } },
                { speaker: 'B', match: 'vp_tom', confidence: { vp_tom: 81 } },
                { speaker: 'C', match: 'vp_tom', confidence: { vp_tom: 70 } },
            ],
        },
        NAMES,
    ),
    missingScoreThenReal: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 40 }],
        {
            identification: [{ speaker: 'A', start: 0, end: 40 }],
            voiceprints: [{ speaker: 'A', match: 'vp_tom' }, { speaker: 'B', match: 'vp_tom', confidence: { vp_tom: 40 } }, { speaker: 'C', match: 'vp_tom' }],
        },
        NAMES,
    ),
    realScoreThenMissing: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 40 }],
        {
            identification: [{ speaker: 'A', start: 0, end: 40 }],
            voiceprints: [{ speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 90 } }, { speaker: 'B', match: 'vp_tom', confidence: { vp_tom: 'n/a' } }],
        },
        NAMES,
    ),
    weakRowDroppedButOtherSpeakerKept: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 40 }],
        {
            identification: [{ speaker: 'A', start: 0, end: 20 }, { speaker: 'B', start: 20, end: 40 }],
            voiceprints: [{ speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 10 } }, { speaker: 'B', match: 'vp_tom', confidence: { vp_tom: 90 } }],
        },
        NAMES,
    ),
    diarizationSpeakerKey: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 30 }, { speakerId: 'S1', start: 30, end: 60 }],
        {
            identification: [
                { diarizationSpeaker: 'B', speaker: 'A', start: 0, end: 30 },
                { diarizationSpeaker: null, speaker: 'A', start: 30, end: 60 },
                { speaker: 'A', match: 'not-ours', start: 30, end: 60 },
            ],
            voiceprints: [{ speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 90 } }, { speaker: 'B', match: 'vp_ann', confidence: { vp_ann: 90 } }],
        },
        NAMES,
    ),
    malformedRows: () => resolveVoiceprintMapping(
        /** @type {any} */ ([null, { speakerId: 'S0', start: '0', end: '30' }, { speakerId: 'S0', start: 30, end: 30 }, { speakerId: 'S2', start: 40, end: 35 }, { speakerId: 'S1', start: 30, end: 60 }]),
        /** @type {any} */ ({
            identification: [null, { speaker: 'A', start: 'x', end: 'y' }, { speaker: 'A', start: '0', end: '30' }, { speaker: 'A', start: 50, end: 50 }, { speaker: 'Z', start: 30, end: 60 }],
            voiceprints: [null, { speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 90 } }, { speaker: 'Z', match: null }, { speaker: 'Y', match: 'vp_nobody' }],
        }),
        NAMES,
    ),
    noLabelledTurns: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 30 }],
        { identification: [{ speaker: 'Q', start: 0, end: 30 }], voiceprints: [{ speaker: 'A', match: 'vp_tom' }] },
        NAMES,
    ),
    twoLabelsOnePerson: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 40 }, { speakerId: 'S1', start: 40, end: 100 }, { speakerId: 'S2', start: 100, end: 160 }],
        {
            identification: [
                { speaker: 'A', start: 0, end: 40 },
                { speaker: 'B', start: 40, end: 50 },
                { speaker: 'A', start: 50, end: 60 },
                { speaker: 'B', start: 100, end: 125 },
                { speaker: 'A', start: 125, end: 130 },
            ],
            voiceprints: [{ speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 90 } }, { speaker: 'B', match: 'vp_tom2', confidence: { vp_tom2: 90 } }],
        },
        NAMES,
    ),
    personWithoutId: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 30 }, { speakerId: 'S1', start: 30, end: 60 }],
        { identification: [{ speaker: 'A', start: 0, end: 30 }], voiceprints: [{ speaker: 'A', match: 'vp_bob', confidence: { vp_bob: 90 } }] },
        NAMES,
    ),
    countWithSinglePin: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 30 }, { speakerId: 'S1', start: 30, end: 60 }],
        {
            identification: [{ speaker: 'A', start: 0, end: 30 }, { speaker: 'B', start: 30, end: 60 }],
            voiceprints: [{ speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 90 } }, { speaker: 'B', match: 'vp_ann', confidence: { vp_ann: 50 } }],
        },
        NAMES,
        { distinctSpeakers: true },
    ),
    threePinsTwoOverlap: () => resolveVoiceprintMapping(
        [
            { speakerId: 'S0', start: 0, end: 20 },
            { speakerId: 'S1', start: 20, end: 50 },
            { speakerId: 'S2', start: 45, end: 80 },
            { speakerId: 'S3', start: 80, end: 120 },
        ],
        {
            identification: [{ speaker: 'A', start: 0, end: 80 }, { speaker: 'B', start: 80, end: 120 }],
            voiceprints: [{ speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 90 } }, { speaker: 'B', match: 'vp_ann', confidence: { vp_ann: 90 } }],
        },
        NAMES,
    ),
    optionOverrides: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 10 }, { speakerId: 'S1', start: 10, end: 20 }],
        {
            identification: [{ speaker: 'A', start: 0, end: 6 }, { speaker: 'B', start: 6, end: 10 }, { speaker: 'B', start: 10, end: 20 }],
            voiceprints: [{ speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 30 } }, { speaker: 'B', match: 'vp_ann', confidence: { vp_ann: 30 } }],
        },
        NAMES,
        { minSeconds: 1, weakConfidence: 20, minConfidence: 25, minShare: 0.5, ambiguityMargin: 0.05, ruledOutShare: 0.45 },
    ),
    ambiguousAtMargin: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 100 }],
        {
            identification: [{ speaker: 'A', start: 0, end: 70 }, { speaker: 'B', start: 70, end: 100 }],
            voiceprints: [{ speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 90 } }, { speaker: 'B', match: 'vp_ann', confidence: { vp_ann: 90 } }],
        },
        NAMES,
        { ambiguityMargin: 0.41 },
    ),
    shortCandidateNotRostered: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 10 }],
        { identification: [{ speaker: 'A', start: 0, end: 6 }], voiceprints: [{ speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 90 } }] },
        NAMES,
    ),
    rosterOrder: () => resolveVoiceprintMapping(
        [{ speakerId: 'S0', start: 0, end: 100 }, { speakerId: 'S1', start: 100, end: 200 }],
        {
            identification: [
                { speaker: 'B', start: 0, end: 45 }, { speaker: 'A', start: 45, end: 100 },
                { speaker: 'C', start: 100, end: 150 }, { speaker: 'A', start: 150, end: 200 },
            ],
            voiceprints: [
                { speaker: 'A', match: 'vp_tom', confidence: { vp_tom: 90 } },
                { speaker: 'B', match: 'vp_ann', confidence: { vp_ann: 90 } },
                { speaker: 'C', match: 'vp_bob', confidence: { vp_bob: 90 } },
            ],
        },
        NAMES,
    ),
};

test('resolveVoiceprintMapping: every case matches the golden result', () => {
    const actual = Object.fromEntries(Object.entries(CASES).map(([name, run]) => [name, run()]));
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(CASES)) assert.deepEqual(actual[name], golden[name], name);
});
