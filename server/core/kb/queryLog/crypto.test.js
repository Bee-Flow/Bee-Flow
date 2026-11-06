'use strict';

/**
 * The sealing of the KB query log: round trip, binding to org / KB / row / field, plain text when
 * the organisation has encryption off, and a loud failure when a write needs a key it cannot get.
 *
 * Run: cd server && node --test core/kb/queryLog/crypto.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const c = require('./crypto.mts');

const ORK = Buffer.alloc(32, 7);
const KB = '11111111-1111-4111-8111-111111111111';
const ROW = 'row-1';
const on = () => c._setCryptoDeps({ getOrgRootKey: async () => ORK, sealingEnabled: async () => true });

test.afterEach(() => c._setCryptoDeps(null));

test('a sealed value is an envelope and opens back to the text', async () => {
    on();
    const sealed = await c.sealField('org1', KB, ROW, 'query', 'Wat is de opzegtermijn?');
    assert.ok(sealed.includes('_bfenc'), 'sealed as an envelope');
    assert.ok(!sealed.includes('opzegtermijn'), 'the text is not in the clear');
    assert.equal(await c.openField('org1', KB, ROW, 'query', sealed), 'Wat is de opzegtermijn?');
});

test('the same text seals differently every time (random IV)', async () => {
    on();
    assert.notEqual(await c.sealField('org1', KB, ROW, 'query', 'x'), await c.sealField('org1', KB, ROW, 'query', 'x'));
});

test('a ciphertext moved to another KB, row, field or organisation does not open', async () => {
    on();
    const sealed = await c.sealField('org1', KB, ROW, 'query', 'secret');
    await assert.rejects(c.openField('org1', '22222222-2222-4222-8222-222222222222', ROW, 'query', sealed));
    await assert.rejects(c.openField('org1', KB, 'row-2', 'query', sealed));
    await assert.rejects(c.openField('org1', KB, ROW, 'answer', sealed));
    await assert.rejects(c.openField('org2', KB, ROW, 'query', sealed));
});

test('the AAD names org, KB, row and field', () => {
    assert.equal(c.fieldAad('o', 'k', 'r', 'chunks'), 'kbql:v1:o:k:r:chunks');
});

test('each KB has its own key', () => {
    assert.notDeepEqual(c.deriveKbKey(ORK, 'o', 'k1'), c.deriveKbKey(ORK, 'o', 'k2'));
    assert.notDeepEqual(c.deriveKbKey(ORK, 'o1', 'k'), c.deriveKbKey(ORK, 'o2', 'k'));
    assert.throws(() => c.deriveKbKey(Buffer.alloc(8), 'o', 'k'));
});

test('null and undefined stay null in both directions', async () => {
    on();
    assert.equal(await c.sealField('org1', KB, ROW, 'answer', null), null);
    assert.equal(await c.sealField('org1', KB, ROW, 'answer', undefined), null);
    assert.equal(await c.openField('org1', KB, ROW, 'answer', null), null);
});

test('plain text when the organisation has encryption off, and it reads back', async () => {
    c._setCryptoDeps({ getOrgRootKey: async () => { throw new Error('must not be asked'); }, sealingEnabled: async () => false });
    const stored = await c.sealField('org1', KB, ROW, 'query', 'hello');
    assert.equal(stored, 'hello');
    assert.equal(await c.openField('org1', KB, ROW, 'query', stored), 'hello');
});

test('a plain value that looks like an envelope is not mistaken for one', async () => {
    c._setCryptoDeps({ sealingEnabled: async () => false });
    const lookalike = JSON.stringify({ _bfenc: 1, alg: 'A256GCM', iv: 'aa', tag: 'bb', ct: 'cc' });
    const stored = await c.sealField('org1', KB, ROW, 'query', lookalike);
    assert.equal((await c.openField('org1', KB, ROW, 'query', stored)).trim(), lookalike);
});

test('encryption on but no usable key: the write throws KbQueryLogKeyUnavailable', async () => {
    c._setCryptoDeps({ getOrgRootKey: async () => { throw new Error('vault down'); }, sealingEnabled: async () => true });
    await assert.rejects(c.sealField('org1', KB, ROW, 'query', 'x'), (e) => e instanceof c.KbQueryLogKeyUnavailable && e.code === 'KB_QUERY_LOG_KEY_UNAVAILABLE');
    c._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32), sealingEnabled: async () => true });
    await assert.rejects(c.sealField('org1', KB, ROW, 'query', 'x'), c.KbQueryLogKeyUnavailable, 'an all-zero key is a cleared key');
});

test('a policy that cannot be read refuses the write instead of storing plain text', async () => {
    c._setCryptoDeps({ sealingEnabled: async () => { throw new Error('db down'); } });
    await assert.rejects(c.sealField('org1', KB, ROW, 'query', 'x'), c.KbQueryLogKeyUnavailable);
});
