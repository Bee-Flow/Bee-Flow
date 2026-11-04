/**
 * modelTier as a tier name or a binding: what tier is asked for, and the note.
 * Run: cd server && node --test appStudio/actionExecutor/modelTierChoice.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { pickModelTier, modelTierNote } = require('./modelTierChoice.mts');

const never = () => { throw new Error('a tier name is not resolved'); };

test('a tier name is used as written; nothing is resolved, no note', () => {
    const pick = pickModelTier('fast', never);
    assert.deepStrictEqual(pick, { tier: 'fast', fromBinding: false, invalid: false });
    assert.strictEqual(modelTierNote(pick, { tierName: 'standard', fellBack: true }), null, 'a written tier keeps its old behaviour');
});

test('no modelTier asks for the default tier', () => {
    for (const raw of [undefined, null, '']) {
        assert.deepStrictEqual(pickModelTier(raw, never), { tier: undefined, fromBinding: false, invalid: false });
    }
});

test('a formula that gives a tier name picks it', () => {
    const pick = pickModelTier({ kind: 'formula', expr: 'x' }, () => '  thinking ');
    assert.deepStrictEqual(pick, { tier: 'thinking', fromBinding: true, invalid: false });
    assert.strictEqual(modelTierNote(pick, { tierName: 'thinking', fellBack: false }), null);
});

test('a static binding works like a formula', () => {
    assert.strictEqual(pickModelTier({ kind: 'static', value: 'fast' }, (b) => b.value).tier, 'fast');
});

test('a formula that gives no tier name falls back to the default tier, with a note', () => {
    for (const value of [null, 42, '', 'two words', '1fast', { tier: 'fast' }, 'x'.repeat(61)]) {
        const pick = pickModelTier({ kind: 'formula', expr: 'x' }, () => value);
        assert.deepStrictEqual(pick, { tier: undefined, fromBinding: true, invalid: true }, JSON.stringify(value));
        assert.match(modelTierNote(pick, { tierName: 'standard' }), /did not give a tier name, so the default tier was used/);
    }
});

test('a formula that throws counts as no tier name', () => {
    const pick = pickModelTier({ kind: 'formula', expr: 'x' }, () => { throw new Error('bad'); });
    assert.strictEqual(pick.invalid, true);
});

test('another binding kind or shape is not a tier', () => {
    assert.strictEqual(pickModelTier({ kind: 'records', tableId: 't' }, never).invalid, true);
    assert.strictEqual(pickModelTier(7, never).invalid, true);
});

test('a formula tier the workspace has not set up names both tiers in the note', () => {
    const pick = pickModelTier({ kind: 'formula', expr: 'x' }, () => 'turbo');
    assert.strictEqual(modelTierNote(pick, { tierName: 'standard', fellBack: true }), 'The model tier "turbo" is not set up in this workspace; "standard" was used.');
});
