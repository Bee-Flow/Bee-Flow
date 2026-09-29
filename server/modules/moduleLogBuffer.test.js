/**
 * moduleLogBuffer tests — bounded ring semantics (per-module cap, LRU module
 * eviction, message truncation, level filter).
 *
 * Run: node --test modules/moduleLogBuffer.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const buf = require('./moduleLogBuffer');

beforeEach(() => buf.clear());

test('append + get round-trip, newest-last, level filter', () => {
    buf.append('m1', 'info', ['hello', { a: 1 }]);
    buf.append('m1', 'error', [new Error('boom')]);
    buf.append('m1', 'debug', ['dbg']);

    const all = buf.get('m1');
    assert.strictEqual(all.length, 3);
    assert.strictEqual(all[0].msg, 'hello {"a":1}');
    assert.strictEqual(all[2].level, 'debug');
    assert.ok(all[1].msg.includes('boom'));

    const errors = buf.get('m1', { level: 'error' });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].level, 'error');
});

test('ring is capped at RING_MAX per module (oldest dropped)', () => {
    for (let i = 0; i < buf.RING_MAX + 50; i++) buf.append('m1', 'info', [`line ${i}`]);
    const all = buf.get('m1', { limit: buf.RING_MAX });
    assert.strictEqual(all.length, buf.RING_MAX);
    assert.strictEqual(all[0].msg, 'line 50');
    assert.strictEqual(all[all.length - 1].msg, `line ${buf.RING_MAX + 49}`);
});

test('messages truncate at MSG_MAX chars', () => {
    buf.append('m1', 'info', ['x'.repeat(buf.MSG_MAX + 500)]);
    assert.strictEqual(buf.get('m1')[0].msg.length, buf.MSG_MAX);
});

test('LRU eviction at MODULES_MAX modules; touching keeps a module alive', () => {
    buf.append('keepme', 'info', ['first']);
    for (let i = 0; i < buf.MODULES_MAX - 1; i++) buf.append(`mod${i}`, 'info', ['x']);
    // Touch keepme so mod0 is now the least recently used…
    buf.append('keepme', 'info', ['again']);
    // …then push one more module over the cap.
    buf.append('overflow', 'info', ['x']);

    assert.strictEqual(buf.get('keepme').length, 2, 'touched module survives');
    assert.strictEqual(buf.get('mod0').length, 0, 'LRU module evicted');
    assert.strictEqual(buf.get('overflow').length, 1);
});

test('get on an unknown module returns [] and limit clamps', () => {
    assert.deepStrictEqual(buf.get('nope'), []);
    buf.append('m1', 'info', ['a']);
    buf.append('m1', 'info', ['b']);
    assert.strictEqual(buf.get('m1', { limit: 1 }).length, 1);
    assert.strictEqual(buf.get('m1', { limit: 1 })[0].msg, 'b', 'newest kept when limited');
});
