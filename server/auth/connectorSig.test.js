/**
 * auth/connectorSig.js is the one HMAC check every Nextcloud-connector route
 * calls (task processing, studio apps, /events/nextcloud, the user-sync
 * webhook). What this file pins about it:
 *
 *   - a correctly signed request verifies; a wrong digest, a stale timestamp
 *     and an unknown instance do not;
 *   - an org lookup that throws is "no org" (null), never a rejection the
 *     route would turn into a 500;
 *   - replay protection is OPT-IN: by default the same signed request
 *     verifies twice (the GET callers send identical requests in one second),
 *     with `{ rejectReplay: true }` only the first delivery does, also when
 *     the hex digest is re-cased; a signature that failed verification is
 *     never remembered.
 *
 * Run: cd server && node --test auth/connectorSig.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const TENANT_KEY = 'tenant-key-org1';
const ORG = { id: 'org1' };
let lookupOrg = async (id) => (id === 'nc-1' ? { ...ORG } : null);

const { verifyConnectorSig, _resetReplayCacheForTests, _setDepsForTests } = require('./connectorSig');

_setDepsForTests({
    userStore: () => ({ getOrganizationByNcInstanceId: (id) => lookupOrg(id) }),
    configStore: () => ({ getSecret: async (k) => (k === `connector_tenant_key_${ORG.id}` ? TENANT_KEY : null) }),
});

test.after(() => _setDepsForTests());
test.beforeEach(() => _resetReplayCacheForTests());

function req({ method = 'POST', url = '/auth/webhook/nc-user-sync', body = '{"a":1}', ts = Math.floor(Date.now() / 1000), instance = 'nc-1', sig } = {}) {
    const digest = sig ?? crypto.createHmac('sha256', TENANT_KEY).update(`${ts}\n${method}\n${url}\n${body}`).digest('hex');
    return {
        method,
        originalUrl: url,
        rawBody: body,
        headers: { 'x-beeflow-nc-instance-id': instance, 'x-beeflow-sig': `${ts}.${digest}` },
    };
}

test('a correctly signed request returns the org', async () => {
    assert.deepStrictEqual(await verifyConnectorSig(req()), ORG);
});

test('a wrong digest, a stale timestamp or an unknown instance is null', async () => {
    assert.strictEqual(await verifyConnectorSig(req({ sig: '0'.repeat(64) })), null);
    assert.strictEqual(await verifyConnectorSig(req({ ts: Math.floor(Date.now() / 1000) - 301 })), null);
    assert.strictEqual(await verifyConnectorSig(req({ instance: 'nc-other' })), null);
});

test('an org lookup that throws is null, not a rejection', async () => {
    const saved = lookupOrg;
    lookupOrg = async () => { throw new Error('db down'); };
    try {
        assert.strictEqual(await verifyConnectorSig(req()), null);
    } finally {
        lookupOrg = saved;
    }
});

test('by default the same signed request verifies twice (identical GETs in one second)', async () => {
    const r = req({ method: 'GET', url: '/api/nextcloud/studio-apps/menus', body: '' });
    assert.deepStrictEqual(await verifyConnectorSig(r), ORG);
    assert.deepStrictEqual(await verifyConnectorSig(r), ORG);
});

test('with rejectReplay only the first delivery of a signature verifies', async () => {
    const r = req();
    assert.deepStrictEqual(await verifyConnectorSig(r, { rejectReplay: true }), ORG);
    assert.strictEqual(await verifyConnectorSig(r, { rejectReplay: true }), null);
});

test('with rejectReplay a re-cased digest is still a replay', async () => {
    const r = req();
    assert.deepStrictEqual(await verifyConnectorSig(r, { rejectReplay: true }), ORG);
    const [ts, hex] = r.headers['x-beeflow-sig'].split('.');
    const upper = { ...r, headers: { ...r.headers, 'x-beeflow-sig': `${ts}.${hex.toUpperCase()}` } };
    assert.strictEqual(await verifyConnectorSig(upper, { rejectReplay: true }), null);
});

test('with rejectReplay a different body in the same second verifies', async () => {
    const ts = Math.floor(Date.now() / 1000);
    assert.deepStrictEqual(await verifyConnectorSig(req({ ts, body: '{"a":1}' }), { rejectReplay: true }), ORG);
    assert.deepStrictEqual(await verifyConnectorSig(req({ ts, body: '{"a":2}' }), { rejectReplay: true }), ORG);
});

test('a signature that failed verification is not remembered', async () => {
    const good = req();
    const forged = { ...good, rawBody: '{"a":9}' }; // same header, other bytes: fails
    assert.strictEqual(await verifyConnectorSig(forged, { rejectReplay: true }), null);
    assert.deepStrictEqual(await verifyConnectorSig(good, { rejectReplay: true }), ORG, 'the genuine delivery still verifies');
});

test('end to end: a signed request through the global JSON parser verifies; an unsigned one gets no rawBody', async () => {
    const express = require('express');
    const { applyBodyParsers } = require('../boot/httpMiddleware');
    const app = express();
    applyBodyParsers(app);
    app.post('/auth/webhook/nc-user-sync', async (r, res) => {
        const org = await verifyConnectorSig(r);
        res.json({ org, hasRaw: r.rawBody !== undefined });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const url = '/auth/webhook/nc-user-sync';
    const body = '{"a":  1}';
    const ts = Math.floor(Date.now() / 1000);
    const digest = crypto.createHmac('sha256', TENANT_KEY).update(`${ts}\nPOST\n${url}\n${body}`).digest('hex');
    try {
        const base = `http://127.0.0.1:${server.address().port}${url}`;
        const signed = await (await fetch(base, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-beeflow-nc-instance-id': 'nc-1', 'x-beeflow-sig': `${ts}.${digest}` } })).json();
        assert.deepStrictEqual(signed, { org: ORG, hasRaw: true });
        const unsigned = await (await fetch(base, { method: 'POST', body, headers: { 'content-type': 'application/json' } })).json();
        assert.deepStrictEqual(unsigned, { org: null, hasRaw: false });
    } finally {
        await new Promise((r) => server.close(r));
    }
});
