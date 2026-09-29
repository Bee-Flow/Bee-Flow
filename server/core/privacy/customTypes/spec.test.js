'use strict';
/**
 * The one validator for a "Your own data" type, and the ids it carries.
 *
 * Run: cd server && node --test core/privacy/customTypes/spec.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isCustomTypeId, newTypeId, legacyTypeId, legacyTermKey, sha256 } = require('./ids');
const { validateTypeSpec, validateTypeList, reservedTokenKeys, specDigest, typesDigest, LIMITS } = require('./spec');

const ID = 'cdt_0123456789';
const words = (over = {}) => ({
    id: ID, name: 'Project code names', description: 'Internal names', method: 'words', tokenKey: 'project_code',
    words: { values: ['Falcon', ' Blue Heron '], caseSensitive: false, wholeWord: true }, ...over,
});
const codes = (e) => e.errors.map(x => x.code);

test('ids: shape, randomness, deterministic legacy ids', () => {
    assert.equal(isCustomTypeId(ID), true);
    for (const bad of ['cdt_012345678', 'cdt_0123456789a', 'CDT_0123456789', 'cdt_012345678G', 'Person', null, 7]) {
        assert.equal(isCustomTypeId(bad), false, String(bad));
    }
    const a = newTypeId();
    assert.equal(isCustomTypeId(a), true);
    assert.notEqual(a, newTypeId());
    // cdt_ + sha256(orgId \0 termId)[0..10]
    assert.equal(legacyTypeId('org1', { id: 't1' }), `cdt_${sha256('org1\0t1').slice(0, 10)}`);
    assert.notEqual(legacyTypeId('org1', { id: 't1' }), legacyTypeId('org2', { id: 't1' }), 'the org is part of the id');
    // A bare string or an id-less term is keyed on label + pattern.
    assert.equal(legacyTermKey('GEHEIM'), sha256('GEHEIM\0GEHEIM'));
    assert.equal(legacyTermKey({ label: 'L', pattern: 'P' }), sha256('L\0P'));
});

test('a valid words type is normalised: trimmed, one method block, server fields set', () => {
    const r = validateTypeSpec({ ...words(), pattern: { source: 'x' }, ai: { prompt: 'x' }, legacy: undefined, origin: 'migrated' },
        { userId: 'u1', now: '2026-09-26T00:00:00.000Z' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.normalized.words, { values: ['Falcon', 'Blue Heron'], caseSensitive: false, wholeWord: true });
    assert.equal(r.normalized.pattern, undefined);
    assert.equal(r.normalized.ai, undefined);
    assert.equal(r.normalized.origin, 'created', 'a client cannot claim a type was migrated');
    assert.equal(r.normalized.createdBy, 'u1');
    assert.equal(r.normalized.status, undefined);
});

test('structural errors drop the type; a forged legacy flag is one of them', () => {
    for (const [type, code] of [
        [{ ...words(), id: 'x' }, 'invalid_id'],
        [{ ...words(), name: '' }, 'name_invalid'],
        [{ ...words(), name: 'x'.repeat(61) }, 'name_invalid'],
        [{ ...words(), method: 'regex' }, 'method_invalid'],
        [{ ...words(), legacy: true }, 'legacy_forged'],
        ['not a type', 'invalid_type'],
    ]) {
        const r = validateTypeSpec(type);
        assert.equal(r.ok, false);
        assert.equal(r.normalized, null, code);
        assert.ok(codes(r).includes(code), `${code}: ${JSON.stringify(r.errors)}`);
    }
    // The same flag on a stored legacy type is kept, and the server says so.
    const stored = [{ ...words(), legacy: true, origin: 'migrated', tokenKey: 'customterm', legacyTermId: 't9' }];
    const ok = validateTypeSpec({ ...words(), tokenKey: 'customterm', legacy: true }, { storedTypes: stored });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));
    assert.equal(ok.normalized.legacy, true);
    assert.equal(ok.normalized.origin, 'migrated');
    assert.equal(ok.normalized.legacyTermId, 't9');
});

test('content errors keep the type, red and not enforced', () => {
    const r = validateTypeSpec(words({ words: { values: ['   '] } }));
    assert.equal(r.ok, false);
    assert.equal(r.normalized.status, 'invalid');
    assert.ok(codes(r).includes('words_empty'));
});

test('a too-long description is cut and reported, the type stays enforced', () => {
    const r = validateTypeSpec(words({ description: 'd'.repeat(LIMITS.descriptionMax + 5) }));
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), ['description_too_long']);
    assert.equal(r.normalized.description.length, LIMITS.descriptionMax);
    assert.equal(r.normalized.status, undefined);
});

test('placeholder names: shape, reserved words, duplicates', () => {
    assert.ok(codes(validateTypeSpec(words({ tokenKey: 'Project' }))).includes('token_key_invalid'));
    assert.ok(codes(validateTypeSpec(words({ tokenKey: 'code_' }))).includes('token_key_invalid'), 'must end with a letter');
    assert.ok(codes(validateTypeSpec(words({ tokenKey: 'x'.repeat(33) }))).includes('token_key_invalid'));
    for (const reserved of ['person', 'email', 'phone_number', 'customterm', 'custom', 'data', 'pii', 'company']) {
        assert.ok(codes(validateTypeSpec(words({ tokenKey: reserved }))).includes('token_key_reserved'), reserved);
    }
    assert.ok(reservedTokenKeys().has('ussocialsecuritynumber'));
    const other = { ...words(), id: 'cdt_aaaaaaaaaa', tokenKey: 'projectcode' };
    assert.ok(codes(validateTypeSpec(words(), { existingTypes: [other] })).includes('token_key_duplicate'),
        'keys equal after removing separators collide, like restoreTokens compares them');
    assert.equal(validateTypeSpec(words({ tokenKey: 'client2_code' })).ok, true, 'digits inside are fine');
});

test('patterns: RE2 only, bounded, never matching empty text', () => {
    const pat = (source, extra = {}) => validateTypeSpec({ ...words(), method: 'pattern', words: undefined, pattern: { source, ...extra } });
    const ok = pat('KL-\\d{5}');
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.normalized.pattern, { source: 'KL-\\d{5}', caseSensitive: false, engine: 're2' });
    assert.ok(codes(pat('KC-(?=\\d{4})\\d{4}')).includes('pattern_invalid'), 'a lookahead is V8-only');
    assert.ok(codes(pat('(a)\\1')).includes('pattern_invalid'), 'a backreference is V8-only');
    assert.ok(codes(pat('\\d*')).includes('pattern_matches_empty'));
    assert.ok(codes(pat('x'.repeat(LIMITS.patternMax + 1))).includes('pattern_too_long'));
    assert.ok(codes(pat('')).includes('pattern_required'));
    // A migrated V8 pattern stays V8 while its source is unchanged.
    const stored = [{ id: ID, legacy: true, method: 'pattern', pattern: { source: 'KC-(?=\\d{4})\\d{4}', engine: 'v8-legacy' } }];
    const legacy = validateTypeSpec({ ...words(), method: 'pattern', tokenKey: 'customterm', words: undefined, pattern: { source: 'KC-(?=\\d{4})\\d{4}' } }, { storedTypes: stored });
    assert.equal(legacy.ok, true, JSON.stringify(legacy.errors));
    assert.equal(legacy.normalized.pattern.engine, 'v8-legacy');
});

test('ai: prompt and floor bounds', () => {
    const ai = (a) => validateTypeSpec({ ...words(), method: 'ai', words: undefined, ai: a });
    assert.equal(ai({ prompt: 'internal project code name', floor: 0.5 }).ok, true);
    assert.equal(ai({ prompt: 'internal project code name' }).normalized.ai.floor, 0.5, 'default floor');
    for (const bad of [{ prompt: 'x' }, { prompt: 'x'.repeat(61) }, { prompt: 'a <<b>>' }, { prompt: 'a\u0007b' }]) {
        assert.ok(codes(ai(bad)).includes('ai_prompt_invalid'), JSON.stringify(bad));
    }
    for (const floor of [0.05, 0.99, '0.5', NaN]) assert.ok(codes(ai({ prompt: 'code name', floor })).includes('ai_floor_invalid'));
});

test('the list: duplicate ids, unique placeholders, at most 6 ai types, legacy exempt from the cap', () => {
    const t = (i, over = {}) => ({ ...words(), id: `cdt_${String(i).padStart(10, '0')}`, tokenKey: `k${'a'.repeat(i % 20)}z`, ...over });
    const dup = validateTypeList([t(1), t(1)]);
    assert.equal(dup.types.length, 1);
    assert.ok(codes(dup).includes('duplicate_id'));

    const keys = validateTypeList([t(1), t(2, { tokenKey: t(1).tokenKey })]);
    assert.equal(keys.types[1].status, 'invalid');
    assert.ok(codes(keys).includes('token_key_duplicate'));

    const ais = Array.from({ length: 7 }, (_, i) => t(i + 1, { method: 'ai', words: undefined, ai: { prompt: `label ${i}`, floor: 0.5 } }));
    const capped = validateTypeList(ais);
    assert.equal(capped.types.filter(x => x.status !== 'invalid').length, 6);
    assert.ok(codes(capped).includes('too_many_ai'));

    const twins = validateTypeList([
        t(1, { method: 'ai', words: undefined, ai: { prompt: 'Code name', floor: 0.5 } }),
        t(2, { method: 'ai', words: undefined, ai: { prompt: ' code NAME ', floor: 0.6 } }),
    ]);
    assert.equal(twins.types[1].status, 'invalid');
    assert.ok(codes(twins).includes('ai_prompt_duplicate'), 'the guard refuses a repeated prompt');

    const many = validateTypeList(Array.from({ length: 52 }, (_, i) => t(i + 1, { tokenKey: `k${i.toString(36).replace(/\d/g, c => 'abcdefghij'[+c])}z` })));
    assert.equal(many.types.length, 50);
    assert.ok(codes(many).includes('too_many_types'));
});

test('digests change with anything a scan can produce, and only then', () => {
    const a = validateTypeSpec(words()).normalized;
    const b = validateTypeSpec(words({ words: { values: ['Falcon', 'Blue Heron', 'Osprey'] } })).normalized;
    const c = { ...a, quality: { found: 1, total: 2, falseAlarms: 0, sentences: 3 }, updatedAt: 'later' };
    assert.notEqual(specDigest(a), specDigest(b));
    assert.equal(specDigest(a), specDigest(c), 'display-only fields do not invalidate caches');
    assert.notEqual(specDigest(a), specDigest({ ...a, name: 'Renamed' }), 'the label is part of what a scan returns');
    assert.equal(typesDigest([]), '');
    assert.notEqual(typesDigest([a, b]), typesDigest([b, a]), 'definition order breaks merge ties');
});
