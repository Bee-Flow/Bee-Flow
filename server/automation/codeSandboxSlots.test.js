'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createSlots } = require('./codeSandboxSlots');

const tick = () => new Promise(r => setImmediate(r));

test('runs start at once while there is room', async () => {
    const { acquireSlot, stats } = createSlots({ maxTotal: 2, maxPerKey: 2 });
    const a = await acquireSlot({ key: 'org1' });
    const b = await acquireSlot({ key: 'org2' });
    assert.deepStrictEqual(stats().running, 2);
    a(); b();
    assert.deepStrictEqual(stats(), { running: 0, waiting: 0, perKey: {} });
});

test('the process cap queues the next run until a slot frees', async () => {
    const { acquireSlot, stats } = createSlots({ maxTotal: 1, maxPerKey: 1 });
    const first = await acquireSlot({ key: 'org1' });
    let second = null;
    acquireSlot({ key: 'org2' }).then(r => { second = r; });
    await tick();
    assert.strictEqual(second, null, 'waits while the only slot is taken');
    assert.strictEqual(stats().waiting, 1);
    first();
    await tick();
    assert.ok(second, 'starts once the slot is released');
    second();
});

test('one org cannot take every slot: its own cap holds it back', async () => {
    const { acquireSlot, stats } = createSlots({ maxTotal: 4, maxPerKey: 2 });
    const held = [await acquireSlot({ key: 'noisy' }), await acquireSlot({ key: 'noisy' })];
    let third = null;
    acquireSlot({ key: 'noisy' }).then(r => { third = r; });
    const other = await acquireSlot({ key: 'quiet' });
    await tick();
    assert.strictEqual(third, null, 'the noisy org waits although the process has room');
    assert.ok(other, 'another org still starts straight away');
    assert.strictEqual(stats().running, 3);
    held[0]();
    await tick();
    assert.ok(third);
    held[1](); third(); other();
});

test('a waiter blocked by its own cap does not hold up another org behind it', async () => {
    const { acquireSlot } = createSlots({ maxTotal: 2, maxPerKey: 1 });
    const a = await acquireSlot({ key: 'a' });
    const b = await acquireSlot({ key: 'b' });
    let a2 = null;
    let c = null;
    acquireSlot({ key: 'a' }).then(r => { a2 = r; });
    acquireSlot({ key: 'c' }).then(r => { c = r; });
    b();
    await tick();
    assert.strictEqual(a2, null, "org a is still at its own cap");
    assert.ok(c, 'org c takes the freed slot');
    a(); await tick();
    assert.ok(a2);
    a2(); c();
});

test('waiting too long fails with a plain busy error', async () => {
    const { acquireSlot, stats } = createSlots({ maxTotal: 1, maxPerKey: 1, maxWaitMs: 20 });
    const held = await acquireSlot({ key: 'x' });
    await assert.rejects(acquireSlot({ key: 'y' }), /busy on this server/);
    assert.strictEqual(stats().waiting, 0, 'the timed-out waiter left the queue');
    held();
});

test('releasing twice is harmless', async () => {
    const { acquireSlot, stats } = createSlots({ maxTotal: 1, maxPerKey: 1 });
    const r = await acquireSlot({ key: 'x' });
    r(); r();
    assert.strictEqual(stats().running, 0);
});
