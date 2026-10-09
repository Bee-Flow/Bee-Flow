/**
 * The project event bus (core/projectEventBus.js): local fan-out always,
 * Redis as a cross-replica doorbell only when it is really there.
 *
 * Redis is a stand-in object (`_setRedis`), no module mocking. Proven:
 *   - without Redis, events reach local subscribers and nothing is published;
 *   - "distributed" waits for the subscriber's `ready` and ends with `end` /
 *     `close` (it used to say true the moment the connection object existed);
 *   - a publish is skipped while the client is not healthy, but the local
 *     subscribers still get the event;
 *   - a replica ignores the echo of its own publish and delivers the others';
 *   - the Redis channel is subscribed once per project and dropped with the
 *     last local listener.
 *
 * Run: cd server && node --test core/projectEventBus.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const bus = require('./projectEventBus');

function fakeRedis() {
    const published = [];
    const subscriber = Object.assign(new EventEmitter(), {
        status: 'connecting',
        channels: new Set(),
        subscribe(channel, cb) { this.channels.add(channel); if (cb) cb(null); },
        unsubscribe(channel) { this.channels.delete(channel); },
    });
    const client = {
        healthy: true,
        duplicate: () => subscriber,
        async publish(channel, message) { published.push({ channel, message: JSON.parse(message) }); },
    };
    return { client, subscriber, published };
}

test.afterEach(() => bus._setRedis());

test('without Redis: local delivery only', async () => {
    bus._setRedis({ getRedis: () => null, redisHealthy: () => false });
    const got = [];
    const off = bus.subscribeProject('p1', (ev) => got.push(ev));
    await bus.publishProjectEvent('p1', { kind: 'chat.created', seq: 1 });
    await bus.publishTransient('p1', { kind: 'presence.typing' });
    assert.deepStrictEqual(got, [{ kind: 'chat.created', seq: 1 }, { kind: 'presence.typing', transient: true }]);
    assert.strictEqual(bus.isDistributed(), false);
    off();
});

test('distributed only once the subscriber is ready, and not after it ends', async () => {
    const r = fakeRedis();
    bus._setRedis({ getRedis: () => r.client, redisHealthy: () => r.client.healthy });
    const off = bus.subscribeProject('p1', () => {});
    assert.strictEqual(bus.isDistributed(), false, 'connecting is not distributed');
    r.subscriber.status = 'ready';
    r.subscriber.emit('ready');
    assert.strictEqual(bus.isDistributed(), true);
    r.subscriber.emit('end');
    assert.strictEqual(bus.isDistributed(), false, 'a lost connection is not distributed');
    r.subscriber.emit('ready');
    assert.strictEqual(bus.isDistributed(), true, 'a reconnect is');
    r.client.healthy = false;
    assert.strictEqual(bus.isDistributed(), false, 'an unhealthy client is not');
    off();
});

test('an unhealthy client skips the publish; local subscribers still get the event', async () => {
    const r = fakeRedis();
    bus._setRedis({ getRedis: () => r.client, redisHealthy: () => r.client.healthy });
    const got = [];
    const off = bus.subscribeProject('p1', (ev) => got.push(ev.kind));
    r.client.healthy = false;
    await bus.publishProjectEvent('p1', { kind: 'a' });
    assert.deepStrictEqual(r.published, []);
    r.client.healthy = true;
    await bus.publishProjectEvent('p1', { kind: 'b' });
    assert.deepStrictEqual(got, ['a', 'b']);
    assert.strictEqual(r.published.length, 1);
    assert.strictEqual(r.published[0].channel, 'bf:project:p1');
    assert.strictEqual(r.published[0].message._origin, bus._originId);
    off();
});

test('the echo of our own publish is dropped; another replica\'s is delivered', () => {
    const r = fakeRedis();
    bus._setRedis({ getRedis: () => r.client, redisHealthy: () => true });
    const got = [];
    const off = bus.subscribeProject('p1', (ev) => got.push(ev));
    r.subscriber.emit('message', 'bf:project:p1', JSON.stringify({ kind: 'mine', _origin: bus._originId }));
    r.subscriber.emit('message', 'bf:project:p1', JSON.stringify({ kind: 'theirs', _origin: 'other-replica' }));
    r.subscriber.emit('message', 'bf:project:p1', '{not json');
    assert.deepStrictEqual(got, [{ kind: 'theirs' }]);
    off();
});

test('one Redis subscription per project, dropped with the last listener', () => {
    const r = fakeRedis();
    bus._setRedis({ getRedis: () => r.client, redisHealthy: () => true });
    const a = bus.subscribeProject('p9', () => {});
    const b = bus.subscribeProject('p9', () => {});
    assert.deepStrictEqual([...r.subscriber.channels], ['bf:project:p9']);
    a();
    assert.deepStrictEqual([...r.subscriber.channels], ['bf:project:p9']);
    b();
    assert.deepStrictEqual([...r.subscriber.channels], []);
});

test('channels: any id string works, locally and over Redis (doc:<id> channel)', async () => {
    const r = fakeRedis();
    bus._setRedis({ getRedis: () => r.client, redisHealthy: () => true });
    const got = [];
    const off = bus.subscribeChannel('doc:d1', (ev) => got.push(ev));
    assert.ok(r.subscriber.channels.has('bf:project:doc:d1'));
    await bus.publishChannel('doc:d1', { kind: 'document.presence' });
    await bus.publishChannel('doc:other', { kind: 'document.presence' });
    assert.deepStrictEqual(got, [{ kind: 'document.presence', transient: true }]);
    assert.strictEqual(r.published[0].channel, 'bf:project:doc:d1');
    // Another replica's publish arrives through the subscriber.
    r.subscriber.emit('message', 'bf:project:doc:d1', JSON.stringify({ kind: 'x', transient: true, _origin: 'elsewhere' }));
    assert.strictEqual(got.length, 2);
    off();
    assert.ok(!r.subscriber.channels.has('bf:project:doc:d1'));
});
