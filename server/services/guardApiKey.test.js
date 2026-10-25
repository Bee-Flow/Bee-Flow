const test = require('node:test');
const assert = require('node:assert');
const { resolveGuardApiKey } = require('./guardApiKey');

const none = async () => '';

test('a key the admin typed wins, trimmed', async () => {
    assert.strictEqual(await resolveGuardApiKey('  typed  ', async () => 'stored'), 'typed');
});

test('no key typed: the stored one from an earlier install is reused', async () => {
    assert.strictEqual(await resolveGuardApiKey(undefined, async () => 'stored'), 'stored');
    assert.strictEqual(await resolveGuardApiKey('   ', async () => 'stored'), 'stored');
});

test('nothing typed or stored: a new key is generated, never an empty one', async () => {
    const k = await resolveGuardApiKey('', none);
    assert.match(k, /^[0-9a-f]{48}$/);
    assert.notStrictEqual(k, await resolveGuardApiKey('', none), 'each call draws a fresh key');
    assert.strictEqual(await resolveGuardApiKey(undefined, async () => null, () => 'fixed'), 'fixed');
});
