// @typecheck
'use strict';

/**
 * Characterisation (golden) test for validateTypeSpec: the whole result
 * (ok, the normalised type, every error in order) for types that reach each
 * branch: a non-object, each structural error alone and together, a forged
 * legacy flag, the description cap, every placeholder outcome (bad, reserved,
 * taken, taken by a legacy type, the legacy key), each method block with its
 * caps and errors (words: junk, trimmed or exact, too long, too many, empty;
 * pattern: missing, too long, RE2 refusal, matches empty, kept on v8 or
 * moved to RE2; ai: prompt and floor bounds, group signature), quality, and
 * the server fields taken from the stored version. validateTypeList runs over
 * the same types, so its use of the per-type result is pinned too.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/privacy/customTypes/spec.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { validateTypeSpec, validateTypeList } = require('./spec');

const GOLDEN = path.join(__dirname, 'spec.characterisation.golden.json');
const NOW = '2026-11-14T00:00:00.000Z';
const ID = 'cdt_00000000aa';
const ID2 = 'cdt_00000000bb';

/** @param {Record<string, unknown>} [over] */
const base = (over = {}) => ({ id: ID, name: ' Project names ', description: ' Code names ', method: 'words', tokenKey: 'project', words: { values: ['Falcon'] }, ...over });
/** @param {Record<string, unknown>} [over] */
const legacyStored = (over = {}) => ({
    id: ID, legacy: true, origin: 'migrated', legacyTermId: 'term-1', createdAt: '2025-01-01T00:00:00.000Z', createdBy: 'u0', updatedAt: '2025-02-01T00:00:00.000Z',
    name: 'Project names', description: 'Code names', method: 'words', tokenKey: 'customterm', words: { values: ['Falcon'], caseSensitive: false, wholeWord: false }, ...over,
});

/** @type {Record<string, [unknown, Record<string, unknown>?]>} */
const CASES = {
    notObject: ['words'],
    arrayType: [[base()]],
    nullType: [null],
    badId: [base({ id: 'cdt_xyz' })],
    noName: [base({ name: '   ' })],
    longName: [base({ name: 'n'.repeat(61) })],
    nameAtCap: [base({ name: 'n'.repeat(60) })],
    badMethod: [base({ method: 'regex' })],
    allStructural: [{ id: 1, name: 2, method: 3, legacy: true }],
    forgedLegacy: [base({ legacy: true })],
    forgedLegacyStoredNotLegacy: [base({ legacy: true }), { storedTypes: [{ id: ID, legacy: false }] }],
    longDescription: [base({ description: 'd'.repeat(450) })],
    descriptionNotString: [base({ description: 7 })],
    tokenKeyMissing: [base({ tokenKey: undefined })],
    tokenKeyBad: [base({ tokenKey: 'Project Code!' })],
    tokenKeyLong: [base({ tokenKey: 'a'.repeat(40) })],
    tokenKeyReserved: [base({ tokenKey: 'email' })],
    tokenKeyReservedData: [base({ tokenKey: 'data' })],
    tokenKeyCustomtermNotLegacy: [base({ tokenKey: 'customterm' })],
    tokenKeyTaken: [base(), { existingTypes: [{ id: ID2, tokenKey: 'pro_ject' }] }],
    tokenKeyTakenBySelf: [base(), { existingTypes: [{ id: ID, tokenKey: 'project' }] }],
    tokenKeyTakenByLegacy: [base({ tokenKey: 'customterm' }), { existingTypes: [{ id: ID2, legacy: true, tokenKey: 'customterm' }] }],
    tokenKeyTakenByLegacyOther: [base(), { existingTypes: [{ id: ID2, legacy: true, tokenKey: 'project' }] }],
    tokenKeyExistingJunk: [base(), { existingTypes: [null, { id: ID2 }, 5] }],
    wordsJunk: [base({ words: { values: [' a ', 'a', '', '  ', 3, null, 'b', 'w'.repeat(121)], caseSensitive: true, wholeWord: false } })],
    wordsNotList: [base({ words: { values: 'Falcon' } })],
    wordsMissing: [base({ words: undefined })],
    wordsEmpty: [base({ words: { values: [] } })],
    wordsTooMany: [base({ words: { values: Array.from({ length: 505 }, (_, i) => `w${i}`) } })],
    wordsWholeWordDefault: [base({ words: { values: ['x'], caseSensitive: 'yes', wholeWord: 'no' } })],
    patternOk: [base({ method: 'pattern', pattern: { source: 'PRJ-\\d{4}', caseSensitive: true } })],
    patternMissing: [base({ method: 'pattern', pattern: {} })],
    patternNotObject: [base({ method: 'pattern', pattern: 'PRJ' })],
    patternTooLong: [base({ method: 'pattern', pattern: { source: 'a'.repeat(301) } })],
    patternRe2Refuses: [base({ method: 'pattern', pattern: { source: '(a)\\1' } })],
    patternBroken: [base({ method: 'pattern', pattern: { source: '(' } })],
    patternMatchesEmpty: [base({ method: 'pattern', pattern: { source: 'a*' } })],
    patternWithWordsToo: [base({ method: 'pattern', pattern: { source: 'x+' }, words: { values: ['ignored'] }, ai: { prompt: 'ignored' } })],
    aiOk: [base({ method: 'ai', ai: { prompt: ' Customer number ', floor: 0.3, groupSignature: 'g1' } })],
    aiDefaults: [base({ method: 'ai', ai: {} })],
    aiNotObject: [base({ method: 'ai', ai: 'x' })],
    aiPromptShort: [base({ method: 'ai', ai: { prompt: 'x', floor: 0.5 } })],
    aiPromptLong: [base({ method: 'ai', ai: { prompt: 'p'.repeat(61) } })],
    aiPromptControl: [base({ method: 'ai', ai: { prompt: 'line\u0007bell' } })],
    aiPromptBrackets: [base({ method: 'ai', ai: { prompt: 'a << b' } })],
    aiPromptBracketsClose: [base({ method: 'ai', ai: { prompt: 'a >> b' } })],
    aiFloorLow: [base({ method: 'ai', ai: { prompt: 'Label', floor: 0.05 } })],
    aiFloorHigh: [base({ method: 'ai', ai: { prompt: 'Label', floor: 0.96 } })],
    aiFloorString: [base({ method: 'ai', ai: { prompt: 'Label', floor: '0.5' } })],
    aiFloorNaN: [base({ method: 'ai', ai: { prompt: 'Label', floor: NaN } })],
    aiGroupSignatureLong: [base({ method: 'ai', ai: { prompt: 'Label', groupSignature: 'g'.repeat(201) } })],
    quality: [base({ quality: { found: 3, total: 4, falseAlarms: -1, sentences: 1.5, at: '2026-01-01', stale: true } })],
    qualityJunk: [base({ quality: { found: 200_000, at: 'x'.repeat(41), stale: 'yes' } })],
    qualityNotObject: [base({ quality: [1] })],
    clientServerFields: [base({ origin: 'migrated', createdBy: 'evil', legacyTermId: 'x', createdAt: '2020-01-01', updatedAt: '2020-01-02' }), { userId: 'u9' }],
    clientCreatedAtLong: [base({ createdAt: 'c'.repeat(41) })],
    noUserId: [base()],
    storedCreated: [base(), { userId: 'u2', storedTypes: [{ id: ID, origin: 'created', createdAt: '2025-03-03', createdBy: null, updatedAt: '2025-04-04', name: 'Project names', description: 'Code names', method: 'words', tokenKey: 'project', words: { values: ['Falcon'] } }] }],
    storedChanged: [base({ words: { values: ['Falcon', 'Heron'] } }), { storedTypes: [{ id: ID, createdAt: '', createdBy: undefined, updatedAt: 9 }] }],
    storedFromExisting: [base(), { existingTypes: [{ id: ID, origin: 'migrated', createdAt: '2025-05-05', createdBy: 'u5' }] }],
    legacyWords: [base({ tokenKey: 'customterm', legacy: true, words: { values: [' exact  ', 'x'.repeat(400), 'y'.repeat(501)] } }), { storedTypes: [legacyStored()] }],
    legacyUnchanged: [{ ...legacyStored(), legacy: true }, { storedTypes: [legacyStored()] }],
    legacyNewKey: [base({ tokenKey: 'project' }), { storedTypes: [legacyStored()] }],
    legacyPatternV8: [base({ method: 'pattern', tokenKey: 'customterm', pattern: { source: '(?<=a)b' } }), { storedTypes: [legacyStored({ method: 'pattern', pattern: { source: '(?<=a)b', engine: 'v8-legacy' } })] }],
    legacyPatternV8Broken: [base({ method: 'pattern', tokenKey: 'customterm', pattern: { source: '(' } }), { storedTypes: [legacyStored({ method: 'pattern', pattern: { source: '(', engine: 'v8-legacy' } })] }],
    legacyPatternChanged: [base({ method: 'pattern', tokenKey: 'customterm', pattern: { source: 'a*' } }), { storedTypes: [legacyStored({ method: 'pattern', pattern: { source: 'b', engine: 'v8-legacy' } })] }],
    legacyPatternLong: [base({ method: 'pattern', tokenKey: 'customterm', pattern: { source: 'a'.repeat(450) } }), { storedTypes: [legacyStored({ method: 'pattern' })] }],
    legacyPatternTooLong: [base({ method: 'pattern', tokenKey: 'customterm', pattern: { source: 'a'.repeat(501) } }), { storedTypes: [legacyStored({ method: 'pattern' })] }],
    legacyNoTermId: [base({ tokenKey: 'customterm' }), { storedTypes: [legacyStored({ legacyTermId: 5 })] }],
};

test('validateTypeSpec: every case matches the golden result', () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const [name, [type, opts]] of Object.entries(CASES)) actual[name] = validateTypeSpec(type, { now: NOW, ...opts });
    actual['list/all'] = validateTypeList(Object.values(CASES).map(([type]) => type), { now: NOW, userId: 'u1' });
    actual['list/legacy'] = validateTypeList(Object.values(CASES).map(([type]) => type), { now: NOW, storedTypes: [legacyStored()] });
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(actual)) assert.deepEqual(actual[name], golden[name], name);
});
