/**
 * A `tables.row.*` push reaches the mirror engine the way the Talk reaction
 * does: BEHIND the ack, inside setImmediate, with a try/catch AND a .catch —
 * a throw on the webhook path is an uncaught exception and takes the process
 * down — and never awaited, because the connector holds its webhook open.
 *
 * Driven through the real route, over a loopback port, with a signed connector
 * request: none of those four claims is visible in the text of events.js.
 * Its file.* twin is covered next door in events.spreadsheetFiles.test.js.
 *
 * Run: cd server && node --test --test-force-exit routes/automation/events.nextcloudTables.test.js
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
const tableEvents = require('../../core/dataEngine/sources/nextcloudTable/events');
const eventsRouter = require('./events');

const ORG = { id: 'org1' };
const TENANT_KEY = 'tenant-key-for-tests';

let order = [];
let seen = [];
let onTablesEventImpl = async () => {};

const originals = [];
const patch = (obj, key, value) => { originals.push([obj, key, obj[key]]); obj[key] = value; };
patch(userStore, 'getOrganizationByNcInstanceId', async (id) => (id === 'nc-instance' ? ORG : null));
patch(userStore, 'getUserByNcUid', async () => ({ id: 'u1' }));
patch(configStore, 'getSecret', async (k) => (k === `connector_tenant_key_${ORG.id}` ? TENANT_KEY : null));
patch(automationStore, 'getSubscriptionsForUserAndEvent', async () => { order.push('stamp'); return []; });
patch(triggerBus, 'dispatchEvent', async () => { order.push('dispatch'); });
patch(tableEvents, 'onTablesEvent', (a) => { order.push('onTablesEvent'); seen.push(a); return onTablesEventImpl(a); });
after(() => { for (const [obj, key, value] of originals) obj[key] = value; });

// One server for the whole file: a per-test one would be closed by the first
// test's after() hook and every request after it would fail to connect.
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

/** A connector push, signed the way the Nextcloud ExApp signs it. */
async function ncPush(body) {
    const url = await server();
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', TENANT_KEY).update(`${ts}\nPOST\n/events/nextcloud\n${raw}`).digest('hex');
    return fetch(`${url}/events/nextcloud`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-beeflow-nc-instance-id': 'nc-instance', 'x-beeflow-sig': `${ts}.${sig}` },
        body: raw,
    });
}
/** Wait for the setImmediate callbacks the ack did not wait for. */
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));
const reset = () => { order = []; seen = []; onTablesEventImpl = async () => {}; };

test('tables.row.* events are handed to the mirror engine, after the trigger dispatch', async () => {
    reset();
    const res = await ncPush({ event: 'tables.row.created', ncUid: 'alice', payload: { rowId: 7 } });
    assert.strictEqual(res.status, 202);
    await settle();
    assert.deepStrictEqual(seen, [{ orgId: 'org1', event: 'tables.row.created', payload: { rowId: 7 } }]);
    assert.deepStrictEqual(order, ['dispatch', 'stamp', 'onTablesEvent'],
        'the trigger dispatch stays first and untouched, and the mirror patch rides behind the ack');

    reset();
    await ncPush({ event: 'talk.message.new', ncUid: 'alice' });
    await settle();
    assert.deepStrictEqual(seen, [], 'only a tables push reaches the mirror');
});

test('the ack does not wait for the mirror patch', async () => {
    reset();
    let release;
    onTablesEventImpl = () => new Promise((r) => { release = r; });
    const res = await ncPush({ event: 'tables.row.updated', ncUid: 'alice' });
    assert.strictEqual(res.status, 202, 'a mirror refresh must never hold the connector\'s webhook open');
    await settle();
    assert.strictEqual(seen.length, 1, 'and it really was started');
    release();
});

test('a mirror patch that throws does not take the process down', async () => {
    reset();
    const crashes = [];
    const onCrash = (e) => crashes.push(e);
    process.on('uncaughtException', onCrash);
    process.on('unhandledRejection', onCrash);
    try {
        onTablesEventImpl = () => { throw new Error('bad require'); };
        assert.strictEqual((await ncPush({ event: 'tables.row.deleted', ncUid: 'alice' })).status, 202);
        await settle();
        onTablesEventImpl = async () => { throw new Error('mirror patch failed'); };
        assert.strictEqual((await ncPush({ event: 'tables.row.deleted', ncUid: 'alice' })).status, 202);
        await settle();
        await settle();
    } finally {
        process.off('uncaughtException', onCrash);
        process.off('unhandledRejection', onCrash);
    }
    assert.deepStrictEqual(crashes, [], 'a webhook path may not raise');
});
