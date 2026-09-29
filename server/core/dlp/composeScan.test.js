'use strict';
/**
 * These pin the bug that six independent reviewers found in the first version
 * of this design: tokenising each unit separately mints the same token for two
 * different people and destroys the alias ambiguity guard.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Neutralise persistence: this suite is about token identity, not storage.
const ledgerStore = require(path.join(__dirname, '..', '..', 'stores', 'piiScanLedgerStore.js'));
ledgerStore.getMany = async () => new Map();
ledgerStore.putMany = async () => {};

const piiDetection = require(path.join(__dirname, '..', 'privacy', 'piiDetection.js'));
const NAMES = ['Tom Smit', 'Gerard de Groot', 'Rene Bakker', 'Tom Bakker', 'Tom'];
piiDetection.detectPii = async (text) => {
    const entities = [];
    for (const n of NAMES) {
        let i = text.indexOf(n);
        while (i !== -1) {
            // Skip a hit that is merely the prefix of a longer name present here.
            const longer = NAMES.some(o => o.length > n.length && text.startsWith(o, i));
            if (!longer) entities.push({ offset: i, length: n.length, category: 'Person', label: 'Person Name', confidence: 0.95 });
            i = text.indexOf(n, i + n.length);
        }
    }
    return { hasPii: entities.length > 0, entities, degraded: false, degradedReason: null, engineFingerprint: 'fp-test' };
};

const dlpRunner = require(path.join(__dirname, 'dlpRunner.js'));
const { composeScan } = require('./composeScan');

const SHIELD = {
    enabled: true, privacyScanEnabled: true,
    piiDetectionAction: 'tokenize', privacyAction: 'redact',
    piiDetectionCategories: [], piiFailureMode: 'fail_open',
};

function convId() { return `conv-compose-${Math.random().toString(36).slice(2)}`; }

test('two different people in two different units never share a token', async () => {
    const r = await composeScan({
        units: ['Report by Tom Smit about the project.', 'Reviewed by Gerard de Groot afterwards.'],
        orgShield: SHIELD, conversationId: convId(),
    });
    assert.strictEqual(r.blocked, false);
    const tokens = Object.keys(r.tokenMap);
    assert.strictEqual(tokens.length, 2, `expected two distinct tokens, got ${JSON.stringify(r.tokenMap)}`);
    assert.strictEqual(new Set(Object.values(r.tokenMap)).size, 2);
    // And each unit carries its own token, not the other's.
    assert.ok(r.units[0] !== r.units[1]);
    assert.ok(!r.units.join(' ').includes('Tom Smit'));
    assert.ok(!r.units.join(' ').includes('Gerard de Groot'));
});

test('three people across three units get three tokens', async () => {
    const r = await composeScan({
        units: ['Tom Smit wrote it.', 'Gerard de Groot reviewed.', 'Rene Bakker approved.'],
        orgShield: SHIELD, conversationId: convId(),
    });
    assert.strictEqual(Object.keys(r.tokenMap).length, 3);
    assert.strictEqual(new Set(Object.keys(r.tokenMap)).size, 3, 'no token may repeat');
});

test('the alias ambiguity guard still sees every unit at once', async () => {
    // "Tom" is ambiguous between "Tom Smit" and "Tom Bakker", so it must not be
    // folded onto either. Split per unit, the guard could not see the conflict.
    const r = await composeScan({
        units: ['Tom Smit signed off.', 'Tom Bakker objected.', 'Later Tom agreed.'],
        orgShield: SHIELD, conversationId: convId(),
    });
    const values = Object.values(r.tokenMap);
    assert.ok(values.includes('Tom Smit'), 'Tom Smit must keep its own token');
    assert.ok(values.includes('Tom Bakker'), 'Tom Bakker must keep its own token');
    assert.ok(Object.keys(r.tokenMap).length >= 2);
});

test('units come back in the same order and count, with frames unscanned', async () => {
    const units = ['alpha Tom Smit', '', 'gamma Gerard de Groot', 'delta'];
    const r = await composeScan({ units, orgShield: SHIELD, conversationId: convId() });
    assert.strictEqual(r.units.length, units.length);
    assert.strictEqual(r.units[1], '');
    assert.strictEqual(r.units[3], 'delta');
    assert.ok(r.units[0].startsWith('alpha '));
});

test('the same value repeated across units counts once, mentions many', async () => {
    const r = await composeScan({
        units: ['Tom Smit here.', 'and Tom Smit again.', 'Tom Smit once more.'],
        orgShield: SHIELD, conversationId: convId(),
    });
    assert.strictEqual(r.count, 1, 'one distinct value = one token-map row');
    assert.strictEqual(r.mentions, 3, 'three occurrences');
});

test('block action returns a verdict instead of quietly tokenising', async () => {
    const r = await composeScan({
        units: ['Tom Smit is here.'],
        orgShield: { ...SHIELD, piiDetectionAction: 'block', privacyAction: 'block' },
        conversationId: convId(),
    });
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(r.reason, 'pii');
    assert.strictEqual(r.tokenMap, null);
});

test('a separator smuggled into a unit cannot desynchronise the split', async () => {
    const r = await composeScan({
        units: [`Tom Smit\x1finjected`, 'Gerard de Groot'],
        orgShield: SHIELD, conversationId: convId(),
    });
    assert.strictEqual(r.units.length, 2);
    assert.ok(!r.units[0].includes('\x1f'));
});

test('shield disabled passes everything through untouched', async () => {
    const units = ['Tom Smit', 'Gerard de Groot'];
    const r = await composeScan({ units, orgShield: { enabled: false }, conversationId: convId() });
    assert.deepStrictEqual(r.units, units);
    assert.strictEqual(r.tokenMap, null);
});

test('tokens continue the conversation numbering instead of restarting', async () => {
    const id = convId();
    const a = await composeScan({ units: ['Tom Smit first.'], orgShield: SHIELD, conversationId: id });
    const b = await composeScan({ units: ['Gerard de Groot second.'], orgShield: SHIELD, conversationId: id });
    const all = { ...a.tokenMap, ...b.tokenMap };
    assert.strictEqual(new Set(Object.keys(all)).size, 2, 'turn 2 must not reuse turn 1\'s token for someone else');
    assert.strictEqual(new Set(Object.values(all)).size, 2);
    dlpRunner.clearConversationState?.(id);
});
