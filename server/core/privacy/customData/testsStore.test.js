'use strict';
/**
 * The encrypted test sets: caps, drops, the 256 KB ceiling, and the
 * configStore secret they live in.
 *
 * Run: node --test core/privacy/customData/testsStore.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeTests, createTestsStore, testsKeyFor, TESTS_LIMITS } = require('./testsStore');

const A = 'cdt_aaaaaaaaaa';
const B = 'cdt_bbbbbbbbbb';
const sentence = (i, extra = {}) => ({ id: `s_${i}`, text: `Order KL-1234${i % 10} is late`, origin: 'assistant', ...extra });

test('keeps a well-formed doc as it is, built from the allow-list', () => {
    const doc = {
        [A]: {
            examples: ['KL-12345'],
            keepFixed: ['KL-'],
            sentences: [sentence(1, { gold: [{ start: 6, end: 14 }] }), { id: 's_2', text: 'nothing', gold: [], origin: 'nearmiss' }, { id: 's_3', text: 'try me' }],
            updatedAt: '2026-09-26T10:00:00.000Z',
            extra: 'dropped',
        },
    };
    const { doc: out, errors } = sanitizeTests(doc, { typeIds: [A], methods: { [A]: 'pattern' } });
    assert.deepEqual(errors, []);
    assert.deepEqual(Object.keys(out[A]).sort(), ['examples', 'keepFixed', 'sentences', 'updatedAt']);
    assert.deepEqual(out[A].sentences[0].gold, [{ start: 6, end: 14 }]);
    assert.deepEqual(out[A].sentences[1].gold, [], 'a near miss keeps its empty gold');
    assert.equal('gold' in out[A].sentences[2], false, 'no gold stays no gold');
    assert.equal(out[A].sentences[2].origin, 'own', 'an absent origin reads as own');
});

test('drops unknown and malformed type ids silently', () => {
    const { doc, errors } = sanitizeTests({ [A]: { examples: [] }, [B]: { examples: [] }, cdt_nothex00000: {}, x: {} }, { typeIds: new Set([A]) });
    assert.deepEqual(Object.keys(doc), [A]);
    assert.deepEqual(errors, []);
});

test('caps examples, keepFixed, sentences and gold, and reports each cap', () => {
    const doc = {
        [A]: {
            examples: [...Array.from({ length: 12 }, (_, i) => `E${i}`), '', 'x'.repeat(101), 'E1'],
            keepFixed: ['KL-', 'AB', 'CD', 'toolongpart'],
            sentences: [
                ...Array.from({ length: 45 }, (_, i) => sentence(i)),
            ],
        },
    };
    const { doc: out, errors } = sanitizeTests(doc, { typeIds: [A] });
    assert.equal(out[A].examples.length, TESTS_LIMITS.maxExamples);
    assert.deepEqual(out[A].keepFixed, ['KL-', 'AB']);
    assert.equal(out[A].sentences.length, TESTS_LIMITS.maxSentences);
    const codes = errors.map((e) => `${e.field}:${e.code}`);
    assert.ok(codes.includes('examples:invalid_entry'));
    assert.ok(codes.includes('examples:too_many'));
    assert.ok(codes.includes('keepFixed:invalid_entry'));
    assert.ok(codes.includes('keepFixed:too_many'));
    assert.ok(codes.includes('sentences:too_many'));
    assert.ok(errors.every((e) => e.id === A && typeof e.message === 'string'));
});

test('keepFixed only for pattern types when methods are known', () => {
    const { doc } = sanitizeTests({ [A]: { keepFixed: ['KL-'] } }, { typeIds: [A], methods: new Map([[A, 'ai']]) });
    assert.equal('keepFixed' in doc[A], false);
});

test('sentences: bad ids, duplicates and bad texts are dropped; gold is repaired', () => {
    const doc = {
        [A]: {
            sentences: [
                { id: 'bad id!', text: 'x' },
                sentence(1),
                sentence(1),
                { id: 's_2', text: '   ' },
                { id: 's_3', text: 'y'.repeat(301) },
                { id: 's_4', text: 'abcdefghij', gold: [{ start: 0, end: 3 }, { start: 2, end: 5 }, { start: 8, end: 20 }, { start: 5, end: 5 }, { start: 5, end: 7 }] },
                { id: 's_5', text: 'abcdefghij', gold: Array.from({ length: 7 }, (_, i) => ({ start: i, end: i + 1 })) },
                { id: 's_6', text: 'abc', gold: 'nope' },
            ],
        },
    };
    const { doc: out, errors } = sanitizeTests(doc, { typeIds: [A] });
    assert.deepEqual(out[A].sentences.map((s) => s.id), ['s_1', 's_4', 's_5', 's_6']);
    assert.deepEqual(out[A].sentences[1].gold, [{ start: 0, end: 3 }, { start: 5, end: 7 }]);
    assert.equal(out[A].sentences[2].gold.length, TESTS_LIMITS.maxGold);
    assert.equal('gold' in out[A].sentences[3], false);
    const codes = errors.map((e) => e.code);
    for (const c of ['invalid_sentence_id', 'duplicate_sentence_id', 'invalid_sentence_text', 'invalid_gold', 'too_many_gold']) {
        assert.ok(codes.includes(c), c);
    }
});

test('the text is never trimmed or cut, so gold offsets stay right', () => {
    const { doc } = sanitizeTests({ [A]: { sentences: [{ id: 's_1', text: '  KL-12345  ', gold: [{ start: 2, end: 10 }] }] } }, { typeIds: [A] });
    const s = doc[A].sentences[0];
    assert.equal(s.text.slice(s.gold[0].start, s.gold[0].end), 'KL-12345');
});

test('over 256 KB is a 400 custom_data_tests_too_large; a non-object is a 400', () => {
    const doc = {};
    for (let t = 0; t < 30; t += 1) {
        const id = `cdt_${t.toString(16).padStart(10, '0')}`;
        doc[id] = { sentences: Array.from({ length: 40 }, (_, i) => ({ id: `s_${i}`, text: `${'ä'.repeat(290)}${i}` })) };
    }
    assert.throws(() => sanitizeTests(doc, {}), (err) => err.status === 400 && err.code === 'custom_data_tests_too_large' && err.details.maxBytes === 262144);
    assert.throws(() => sanitizeTests([], {}), (err) => err.status === 400 && err.code === 'invalid_request');
    assert.deepEqual(sanitizeTests(undefined), { doc: {}, errors: [] });
});

test('read and write go through the per-org encrypted secret', async () => {
    const rows = new Map();
    const audits = [];
    const configStore = {
        getSecret: async (k) => (rows.has(k) ? rows.get(k) : null),
        setSecret: async (k, v, audit) => { rows.set(k, v); audits.push(audit); },
        deleteConfig: async (k) => { rows.delete(k); return true; },
    };
    const warnings = [];
    const store = createTestsStore({ configStore, log: { warn: (m) => warnings.push(m) } });
    assert.equal(testsKeyFor('org-1'), 'org_org-1_custom_data_tests');
    assert.equal(await store.readTests('org-1'), null);

    const doc = { [A]: { examples: ['KL-12345'], sentences: [] } };
    await store.writeTests('org-1', doc, { userId: 'u1' });
    assert.equal(typeof rows.get('org_org-1_custom_data_tests'), 'string');
    assert.deepEqual(audits[0], { orgId: 'org-1', integration: 'custom_data_tests', userId: 'u1' });
    assert.deepEqual(await store.readTests('org-1'), doc);

    await store.writeTests('org-1', {});
    assert.equal(rows.has('org_org-1_custom_data_tests'), false, 'an empty doc removes the row');

    rows.set('org_org-2_custom_data_tests', '{not json');
    assert.equal(await store.readTests('org-2'), null);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes('not json'), 'the stored text is never logged');

    await assert.rejects(store.writeTests('', doc), (err) => err.status === 400);
    await assert.rejects(store.writeTests('org-1', 'x'), (err) => err.status === 400);
});
