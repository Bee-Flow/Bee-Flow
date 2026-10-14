const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('./toolFamilyRegistry');

const { NOT_HANDLED, registerToolFamily, unregisterToolFamily, getToolFamily, listToolFamilies, dispatchToToolFamily } = registry;

// The registry is process-wide; every family here carries this prefix and is
// removed again after each test.
const PREFIX = 'regtest_';
afterEach(() => {
    for (const f of listToolFamilies()) if (f.name.startsWith(PREFIX)) unregisterToolFamily(f.name);
});

const exact = (tool) => (n) => n === tool;

test('rejects a family without a name, predicate, executor or finite order', () => {
    assert.throws(() => registerToolFamily(), TypeError);
    assert.throws(() => registerToolFamily({ name: '', isTool: () => true, execute: () => 1 }), TypeError);
    assert.throws(() => registerToolFamily({ name: `${PREFIX}a`, execute: () => 1 }), /isTool/);
    assert.throws(() => registerToolFamily({ name: `${PREFIX}a`, isTool: () => true }), /execute/);
    assert.throws(() => registerToolFamily({ name: `${PREFIX}a`, isTool: () => true, execute: () => 1, order: NaN }), /order/);
});

test('dispatches to the family that claims the name, with the context untouched', async () => {
    let seen = null;
    registerToolFamily({
        name: `${PREFIX}echo`, isTool: exact('regtest_echo'),
        execute: async (name, args, ctx) => { seen = { name, args, ctx }; return { ok: args.v }; },
    });
    const ctx = { userId: 'u1' };
    const out = await dispatchToToolFamily('regtest_echo', { v: 7 }, ctx);
    assert.deepEqual(out, { handled: true, result: { ok: 7 } });
    assert.equal(seen.ctx, ctx);
    assert.deepEqual(await dispatchToToolFamily('regtest_nobody', {}, {}), { handled: false });
});

test('walks by ascending order, keeping registration order on a tie', async () => {
    const calls = [];
    const claimAll = (n) => n === 'regtest_shared';
    const family = (name, order) => ({ name, order, isTool: claimAll, execute: async () => { calls.push(name); return name; } });
    registerToolFamily(family(`${PREFIX}late`, 2000));
    registerToolFamily(family(`${PREFIX}tie_first`, 5));
    registerToolFamily(family(`${PREFIX}tie_second`, 5));
    const ours = listToolFamilies().filter(f => f.name.startsWith(PREFIX)).map(f => f.name);
    assert.deepEqual(ours, [`${PREFIX}tie_first`, `${PREFIX}tie_second`, `${PREFIX}late`]);
    assert.deepEqual(await dispatchToToolFamily('regtest_shared', {}, {}), { handled: true, result: `${PREFIX}tie_first` });
    assert.deepEqual(calls, [`${PREFIX}tie_first`]);
});

test('NOT_HANDLED passes the call on to the next family that claims it', async () => {
    registerToolFamily({ name: `${PREFIX}prefix`, order: 1, isTool: n => n.startsWith('regtest_p_'), execute: async () => NOT_HANDLED });
    registerToolFamily({ name: `${PREFIX}owner`, order: 2, isTool: exact('regtest_p_owned'), execute: async () => 'owned' });
    assert.deepEqual(await dispatchToToolFamily('regtest_p_owned', {}, {}), { handled: true, result: 'owned' });
    assert.deepEqual(await dispatchToToolFamily('regtest_p_orphan', {}, {}), { handled: false });
});

test('registering a name again replaces the entry; extra properties are kept', async () => {
    registerToolFamily({ name: `${PREFIX}x`, isTool: exact('regtest_x'), execute: async () => 'old' });
    registerToolFamily({ name: `${PREFIX}x`, isTool: exact('regtest_x'), execute: async () => 'new', parseName: () => 'p' });
    assert.equal(listToolFamilies().filter(f => f.name === `${PREFIX}x`).length, 1);
    assert.equal((await dispatchToToolFamily('regtest_x', {}, {})).result, 'new');
    assert.equal(getToolFamily(`${PREFIX}x`).parseName(), 'p');
    assert.equal(getToolFamily(`${PREFIX}missing`), null);
    assert.equal(unregisterToolFamily(`${PREFIX}missing`), false);
});

test('a registered entry is frozen and the listing is a snapshot', () => {
    const entry = registerToolFamily({ name: `${PREFIX}frozen`, isTool: () => false, execute: () => null });
    assert.ok(Object.isFrozen(entry));
    assert.equal(entry.order, 1000, 'default order');
    const snapshot = listToolFamilies();
    snapshot.length = 0;
    assert.ok(listToolFamilies().some(f => f.name === `${PREFIX}frozen`));
});
