/**
 * A Nextcloud `file.*` push and a Graph drive notification reach the
 * spreadsheet-mirror engine the way the Talk reaction and the Tables event do:
 * BEHIND the ack, inside setImmediate, with a try/catch AND a .catch — a throw
 * on a webhook path is an uncaught exception, and an uncaught exception takes
 * the process down — and never awaited, because the connector holds its
 * webhook open while we answer and a slow bot is one Talk marks unhealthy.
 *
 * All four of those are things a regex over events.js cannot tell you, so the
 * route is served for real here: an express app on a loopback port, a signed
 * connector request, and an engine that is slow, that throws, and that rejects.
 *
 * Run: cd server && node --test --test-force-exit routes/automation/events.spreadsheetFiles.test.js
 */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const express = require('express');

const configStore = require('../../stores/configStore');
const userStore = require('../../stores/userStore');
const automationStore = require('../../stores/automationStore');
const triggerBus = require('../../automation/triggerBus');
const spreadsheetEvents = require('../../core/dataEngine/sources/spreadsheetFile/events');
const tableEvents = require('../../core/dataEngine/sources/nextcloudTable/events');
const eventsRouter = require('./events');

const ORG = { id: 'org1', name: 'Acme' };
const USER = { id: 'u1' };
const TENANT_KEY = 'tenant-key-for-tests';

// What every stub writes to, in the order it was called: the ack's position in
// this list is the whole "behind the 202" claim.
let order = [];
let hints = [];
let fileEvents = [];
let tablesEvents = [];
let dispatched = [];
/** Set by a test to make the engine slow, throwing, or rejecting. */
let onFileEventImpl = async () => {};
let onProviderHintImpl = async () => {};

const originals = [];
function patch(obj, key, value) {
    originals.push([obj, key, obj[key]]);
    obj[key] = value;
}

patch(userStore, 'getOrganizationByNcInstanceId', async (id) => (id === 'nc-instance' ? ORG : null));
patch(userStore, 'getUserByNcUid', async (orgId, uid) => (orgId === ORG.id && uid === 'alice' ? USER : null));
patch(configStore, 'getSecret', async (k) => (k === `connector_tenant_key_${ORG.id}` ? TENANT_KEY : null));
patch(automationStore, 'getSubscriptionsForUserAndEvent', async () => { order.push('stamp'); return []; });
patch(automationStore, 'getSubscriptionByExternalRef', async (provider, ref) => SUBS[ref] || null);
patch(triggerBus, 'dispatchEvent', async (e) => { order.push('dispatch'); dispatched.push(e); });
patch(spreadsheetEvents, 'onFileEvent', (a) => { order.push('onFileEvent'); fileEvents.push(a); return onFileEventImpl(a); });
patch(spreadsheetEvents, 'onProviderHint', (a) => { order.push('onProviderHint'); hints.push(a); return onProviderHintImpl(a); });
patch(tableEvents, 'onTablesEvent', async (a) => { order.push('onTablesEvent'); tablesEvents.push(a); });

const SUBS = {};

after(() => { for (const [obj, key, value] of originals) obj[key] = value; });

// One server for the whole file: a per-test one would be closed by the first
// test's after() hook and every request after it would simply fail to connect.
let base = null;
let httpServer = null;
async function server() {
    if (base) return base;
    const app = express();
    app.use(eventsRouter);
    httpServer = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
    base = `http://127.0.0.1:${httpServer.address().port}`;
    return base;
}
after(() => { if (httpServer) httpServer.close(); });

function reset() {
    order = []; hints = []; fileEvents = []; tablesEvents = []; dispatched = [];
    onFileEventImpl = async () => {};
    onProviderHintImpl = async () => {};
    for (const k of Object.keys(SUBS)) delete SUBS[k];
}

/** A connector push, signed the way the Nextcloud ExApp signs it. */
async function ncPush(body, { instanceId = 'nc-instance' } = {}) {
    const url = await server();
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const message = `${ts}\nPOST\n/events/nextcloud\n${raw}`;
    const sig = crypto.createHmac('sha256', TENANT_KEY).update(message).digest('hex');
    return fetch(`${url}/events/nextcloud`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-beeflow-nc-instance-id': instanceId,
            'x-beeflow-sig': `${ts}.${sig}`,
        },
        body: raw,
    });
}

const graphPush = async (notifications, query = '') => fetch(`${await server()}/events/msgraph${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: notifications }),
});

/** Wait for the setImmediate callbacks the ack did not wait for. */
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test('an unsigned push reaches nothing at all', async () => {
    reset();
    const url = await server();
    const res = await fetch(`${url}/events/nextcloud`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'file.changed', ncUid: 'alice' }),
    });
    assert.strictEqual(res.status, 401);
    await settle();
    assert.deepStrictEqual(order, []);
});

test('a file.* push reaches the mirror engine, after the trigger dispatch and before the push stamp', async () => {
    reset();
    const res = await ncPush({ event: 'file.changed', ncUid: 'alice', payload: { path: '/Facturen/2026.xlsx' } });
    assert.strictEqual(res.status, 202);
    await settle();

    assert.deepStrictEqual(fileEvents, [{
        orgId: 'org1', event: 'file.changed',
        payload: { path: '/Facturen/2026.xlsx' },
        actorUserId: 'u1',
    }], 'the Bee Flow user the ncUid mapping resolved rides along — a rename re-points the stored path');
    assert.deepStrictEqual(order, ['dispatch', 'stamp', 'onFileEvent'],
        'the routine trigger first, the ack and its stamp next, the mirror refresh behind them');
    assert.deepStrictEqual(dispatched.map((d) => d.event), ['file.changed'], 'the trigger dispatch is untouched');
});

test('every file.* verb the mirror cares about gets through, and nothing else does', async () => {
    for (const event of ['file.changed', 'file.new', 'file.deleted', 'file.renamed', 'file.restored', 'file.copied']) {
        reset();
        await ncPush({ event, ncUid: 'alice' });
        await settle();
        assert.deepStrictEqual(fileEvents.map((f) => f.event), [event]);
    }
    for (const event of ['file.locked', 'talk.message.new']) {
        reset();
        await ncPush({ event, ncUid: 'alice' });
        await settle();
        assert.deepStrictEqual(fileEvents, [], `${event} is not a mirror event`);
    }
});

test('the ack does not wait for the engine — the connector is answered while it is still running', async () => {
    reset();
    let release;
    onFileEventImpl = () => new Promise((r) => { release = r; });
    const res = await ncPush({ event: 'file.changed', ncUid: 'alice' });
    assert.strictEqual(res.status, 202, 'answered while the mirror refresh has not finished');
    await settle();
    assert.strictEqual(fileEvents.length, 1, 'and it really was started');
    release();
});

test('an engine that throws — synchronously or as a rejection — does not take the process down', async () => {
    reset();
    const crashes = [];
    const onCrash = (e) => crashes.push(e);
    process.on('uncaughtException', onCrash);
    process.on('unhandledRejection', onCrash);
    try {
        onFileEventImpl = () => { throw new Error('bad require'); };
        assert.strictEqual((await ncPush({ event: 'file.changed', ncUid: 'alice' })).status, 202);
        await settle();

        onFileEventImpl = async () => { throw new Error('mirror refresh failed'); };
        assert.strictEqual((await ncPush({ event: 'file.new', ncUid: 'alice' })).status, 202);
        await settle();
        await settle();
    } finally {
        process.off('uncaughtException', onCrash);
        process.off('unhandledRejection', onCrash);
    }
    assert.deepStrictEqual(crashes, [], 'a webhook path may not raise');
});

test('the Tables hook is untouched by the file hook: same shape, its own engine', async () => {
    reset();
    const res = await ncPush({ event: 'tables.row.updated', ncUid: 'alice', payload: { row: 1 } });
    assert.strictEqual(res.status, 202);
    await settle();
    assert.deepStrictEqual(tablesEvents, [{ orgId: 'org1', event: 'tables.row.updated', payload: { row: 1 } }]);
    assert.deepStrictEqual(fileEvents, [], 'a tables push is not a file push');
    assert.deepStrictEqual(order, ['dispatch', 'stamp', 'onTablesEvent']);
});

test('a Graph drive notification hints the OneDrive mirrors of that subscription\'s user, behind the ack', async () => {
    reset();
    SUBS.sub1 = { id: 's1', userId: 'u1', eventType: 'file.changed', clientState: 'cs' };
    const res = await graphPush([{ subscriptionId: 'sub1', clientState: 'cs', resource: 'Users/x/Drive' }]);
    assert.strictEqual(res.status, 202);
    await settle();
    assert.deepStrictEqual(hints, [{ provider: 'onedrive', userId: 'u1' }]);
    assert.deepStrictEqual(order, ['dispatch', 'onProviderHint'], 'the trigger dispatch stays first and untouched');
});

test('a notification without a resolved subscription hints nobody', async () => {
    reset();
    await graphPush([{ subscriptionId: 'unknown', clientState: 'cs' }]);
    await settle();
    assert.deepStrictEqual(hints, []);

    // Nor does one whose subscription is not a drive subscription.
    reset();
    SUBS.sub2 = { id: 's2', userId: 'u1', eventType: 'mail.new', clientState: 'cs' };
    await graphPush([{ subscriptionId: 'sub2', clientState: 'cs' }]);
    await settle();
    assert.deepStrictEqual(hints, []);
});

test('the validation handshake and the clientState check come before any hint', async () => {
    reset();
    SUBS.sub1 = { id: 's1', userId: 'u1', eventType: 'file.changed', clientState: 'cs' };

    const handshake = await fetch(`${await server()}/events/msgraph?validationToken=abc123`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: [{ subscriptionId: 'sub1', clientState: 'cs' }] }),
    });
    assert.strictEqual(handshake.status, 200);
    assert.strictEqual(await handshake.text(), 'abc123', 'the token is echoed as plain text');
    await settle();
    assert.deepStrictEqual(order, [], 'the handshake dispatches nothing and hints nobody');

    // A leaked notificationUrl cannot be used to forge events for another tenant.
    reset();
    SUBS.sub1 = { id: 's1', userId: 'u1', eventType: 'file.changed', clientState: 'cs' };
    await graphPush([{ subscriptionId: 'sub1', clientState: 'wrong' }]);
    await settle();
    assert.deepStrictEqual(order, [], 'a clientState mismatch is dropped before the dispatch');
});

test('an engine that throws on the Graph path does not take the process down either', async () => {
    reset();
    SUBS.sub1 = { id: 's1', userId: 'u1', eventType: 'file.new', clientState: 'cs' };
    const crashes = [];
    const onCrash = (e) => crashes.push(e);
    process.on('uncaughtException', onCrash);
    process.on('unhandledRejection', onCrash);
    try {
        onProviderHintImpl = () => { throw new Error('bad require'); };
        assert.strictEqual((await graphPush([{ subscriptionId: 'sub1', clientState: 'cs' }])).status, 202);
        await settle();
        onProviderHintImpl = async () => { throw new Error('hint failed'); };
        assert.strictEqual((await graphPush([{ subscriptionId: 'sub1', clientState: 'cs' }])).status, 202);
        await settle();
        await settle();
    } finally {
        process.off('uncaughtException', onCrash);
        process.off('unhandledRejection', onCrash);
    }
    assert.deepStrictEqual(crashes, []);
});
