import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchInputs, normalizeKey, sampleType, isSecretLikeKey, typeFits, idAffinityBase } from './match.mjs';
import { MATCH_CASES } from './matchCases.mjs';

const cand = (key, path = key, extra = {}) => ({ key, path, ...extra });
const paths = r => Object.fromEntries(r.matches.map(m => [m.key, m.path]));

test('the small helpers', () => {
    assert.equal(normalizeKey('Message_ID'), 'messageid');
    assert.equal(sampleType([]), 'array');
    assert.equal(sampleType(null), 'null');
    assert.equal(sampleType(3), 'number');
    assert.ok(isSecretLikeKey('client_secret'));
    assert.ok(!isSecretLikeKey('subject'));
    assert.ok(typeFits('string', 'number'), 'a text input takes a number');
    assert.ok(!typeFits('number', 'array'));
    assert.ok(typeFits(['null', 'integer'], 'number'));
    assert.ok(typeFits('number', 'null'), 'an empty sample says nothing');
    assert.equal(idAffinityBase('messageId'), 'message');
    assert.equal(idAffinityBase('message_id'), 'message');
    assert.equal(idAffinityBase('id'), null);
});

test('exact beats normalized; nearest beats earlier', () => {
    const r = matchInputs(
        [{ key: 'email' }, { key: 'maxResults' }],
        [cand('email', 'far.email', { near: 0 }), cand('Email', 'near.Email', { near: 1 }), cand('max_results', 'x.max_results'), cand('email', 'near.email', { near: 1 })],
    );
    assert.deepStrictEqual(paths(r), { email: 'near.email', maxResults: 'x.max_results' });
    assert.deepStrictEqual(r.matches.map(m => m.how), ['exact', 'normalized']);
});

test('required inputs are matched first and win the shared candidate', () => {
    const r = matchInputs(
        [{ key: 'ownerId' }, { key: 'messageId', required: true }],
        [cand('id')],
        { idAffinity: true },
    );
    assert.deepStrictEqual(paths(r), { messageId: 'id' }, 'the id link is used once, by the required input');
});

test('unique never binds a candidate twice; without it a used one is a last resort', () => {
    const inputs = [{ key: 'to' }, { key: 'To' }];
    assert.deepStrictEqual(paths(matchInputs(inputs, [cand('to')], { unique: true })), { to: 'to' });
    assert.deepStrictEqual(paths(matchInputs(inputs, [cand('to')])), { to: 'to', To: 'to' });
});

test('the type gate and the secret rule', () => {
    assert.deepStrictEqual(paths(matchInputs([{ key: 'count', type: 'number' }], [cand('count', 'c', { type: 'array' })])), {});
    assert.deepStrictEqual(paths(matchInputs([{ key: 'token' }], [cand('token')], { skipSecrets: true })), {});
    assert.deepStrictEqual(paths(matchInputs([{ key: 'pageToken', required: true }], [cand('pageToken')], { unique: true })), { pageToken: 'pageToken' },
        'without skipSecrets a secret-like name binds like any other (the AI builder says what it bound)');
});

test('a top-level field ranks before one an object level down; only the same depth ties', () => {
    const item = [cand('id'), cand('subject'), cand('id', 'from.id', { depth: 1 }), cand('name', 'from.name', { depth: 1 })];
    const r = matchInputs([{ key: 'messageId' }, { key: 'id' }, { key: 'name' }], item, { idAffinity: true, unique: true, ambiguous: true });
    assert.deepStrictEqual(paths(r), { messageId: 'id', id: 'from.id', name: 'from.name' });
    assert.deepStrictEqual(r.ambiguous, []);
    const deep = matchInputs([{ key: 'id' }], [cand('id', 'a.id', { depth: 1 }), cand('id', 'b.id', { depth: 1 })], { ambiguous: true });
    assert.deepStrictEqual(deep.ambiguous, [{ key: 'id', paths: ['a.id', 'b.id'] }]);
});

test('a tie in the winning tier is reported, not guessed, when asked', () => {
    const r = matchInputs([{ key: 'content' }], [cand('content', 'output.content'), cand('content', 'item.content')], { ambiguous: true });
    assert.deepStrictEqual(r.matches, []);
    assert.deepStrictEqual(r.ambiguous, [{ key: 'content', paths: ['output.content', 'item.content'] }]);
    assert.equal(matchInputs([{ key: 'content' }], [cand('content', 'output.content'), cand('content', 'item.content')]).matches[0].path, 'output.content');
});

test('max stops early', () => {
    assert.equal(matchInputs([{ key: 'a' }, { key: 'b' }], [cand('a'), cand('b')], { max: 1 }).matches.length, 1);
});

test('the shared cases, matched against the item fields the way both builders do', () => {
    for (const c of MATCH_CASES) {
        // The item's fields, and one level of nesting one `depth` down (what
        // the web offers; the AI builder only knows the top level).
        const fields = Object.entries(c.item).flatMap(([key, v]) => [
            cand(key, c.fanout ? `output.${key}` : key, { type: sampleType(v) }),
            ...(!c.fanout && v && typeof v === 'object' && !Array.isArray(v)
                ? Object.entries(v).map(([ck, cv]) => cand(ck, `${key}.${ck}`, { type: sampleType(cv), depth: 1 }))
                : []),
        ]);
        const inputs = Object.entries(c.inputs).map(([key, s]) => ({ key, type: s.type, required: true }));
        const want = expect => Object.fromEntries(Object.entries(expect).filter(([, p]) => p !== null));
        const opts = { idAffinity: true, unique: true, ambiguous: true };
        assert.deepStrictEqual(paths(matchInputs(inputs, fields, { ...opts, skipSecrets: true })), want(c.expect), `${c.name} (web)`);
        assert.deepStrictEqual(paths(matchInputs(inputs, fields, opts)), want({ ...c.expect, ...c.aiBuilder }), `${c.name} (AI builder)`);
    }
});
