/**
 * What the Nextcloud event webhook accepts once the signature holds, and what
 * it says when it refuses (routes/webhooks/ncEvents.js).
 *
 * The connector (nextcloud-connector/src/eventsWebhook.js) sends exactly
 * `{ event, ncUid, groupId }`, signed with the org's tenant key. Two silent
 * outcomes lived here:
 *
 *   - an event name outside the five was answered `200 { ignored }`, so a
 *     `user.deleted` spelled any other way left the account active and the
 *     connector — which logs only a non-2xx — logged nothing;
 *   - `ncUid` was gated on truthiness, so an array reached the sync.
 *
 * What this file pins:
 *
 *   - the signature is checked BEFORE the schema: unsigned is 401, whatever
 *     the body says;
 *   - a refused body is a 400 that names the field, in a sentence;
 *   - the sync is never reached for a refused body;
 *   - the body the connector sends still applies;
 *   - a signed delivery is accepted ONCE: the same bytes replayed inside the
 *     5-minute window are a 401 and never reach the sync again (a captured
 *     `user.deleted` used to be replayable for the whole window);
 *   - a failing org lookup is the same 401 as an unknown org, not a 500.
 *
 * A real Express app on 127.0.0.1:0, with the same raw-body hook index.js
 * installs globally, so the HMAC is computed over the bytes that were sent.
 *
 * Run: cd server && node --test routes/webhooks/ncEvents.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Module = require('module');
const express = require('express');

const TENANT_KEY = 'test-tenant-key-for-org1';
const INSTANCE_ID = 'nc-instance-1';
const ORG = { id: 'org1', nc_sync_mode: 'mirror_all' };

// Every sync call lands in `touched`. A refused request must leave it empty.
const touched = [];

// The org lookup the signature check makes; a test may make it throw.
let lookupOrg = async (id) => (id === INSTANCE_ID ? { ...ORG } : null);
const userStoreMock = { getOrganizationByNcInstanceId: (id) => lookupOrg(id) };
const configStoreMock = {
    getSecret: async (key) => (key === `connector_tenant_key_${ORG.id}` ? TENANT_KEY : null),
};

const MOCKS = {
    // The route's own requires, and the ones auth/connectorSig.js (the shared
    // signature check the route calls) makes from its own directory.
    '../../stores/userStore': userStoreMock,
    '../../stores/configStore': configStoreMock,
    '../stores/userStore': userStoreMock,
    '../stores/configStore': configStoreMock,
    '../../services/ncUserGroupSync': {
        applyUserCreated: async (org, ncUid) => { touched.push({ what: 'applyUserCreated', args: [org.id, ncUid] }); return { action: 'update' }; },
        applyUserDeleted: async (org, ncUid) => { touched.push({ what: 'applyUserDeleted', args: [org.id, ncUid] }); return { action: 'deactivate', userId: 'nc_org1_alice' }; },
        applyGroupMemberChange: async (org, ncUid, groupId) => { touched.push({ what: 'applyGroupMemberChange', args: [org.id, ncUid, groupId] }); return { action: 'noop' }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:nc-events-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /(webhooks[\\/]ncEvents|auth[\\/]connectorSig)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./ncEvents');
const { createTerminalErrorHandler } = require('../../core/http/terminalErrorHandler');

const PATH = '/auth/webhook/nc-user-sync';
let base;
let server;

test.before(async () => {
    const app = express();
    // What index.js mounts globally, ahead of every router.
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
    app.use('/auth', router);
    app.use(createTerminalErrorHandler({ log: { warn() {}, error() {} } }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    Module._resolveFilename = originalResolve;
    server.closeAllConnections();
    server.close();
});

test.beforeEach(() => { touched.length = 0; });

/** The X-Beeflow-Sig header the connector would send for `raw`. */
function sign(raw, ts = Math.floor(Date.now() / 1000)) {
    return `${ts}.${crypto.createHmac('sha256', TENANT_KEY).update(`${ts}\nPOST\n${PATH}\n${raw}`).digest('hex')}`;
}

/** POST exactly `raw` with exactly `sigHeader`. */
async function send(raw, sigHeader) {
    const res = await fetch(`${base}${PATH}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Beeflow-NC-Instance-Id': INSTANCE_ID,
            'X-Beeflow-Sig': sigHeader,
        },
        body: raw,
    });
    return { status: res.status, body: await res.json() };
}

/** POST exactly `raw`, signed the way the connector signs it. */
async function post(raw, { signed = true } = {}) {
    const ts = Math.floor(Date.now() / 1000);
    return send(raw, signed ? sign(raw, ts) : `${ts}.${'0'.repeat(64)}`);
}

async function refuses(payload, field) {
    const res = await post(JSON.stringify(payload));
    assert.strictEqual(res.status, 400, `${JSON.stringify(payload)} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.doesNotMatch(res.body.error, /^Required$|Invalid enum value|Expected/, 'no zod internals');
    assert.deepStrictEqual(touched, [], 'a refused event must not reach the sync');
    return res;
}

// ═══ the order: signature, then schema ══════════════════════════════

test('an unsigned body is a 401 whatever it says — the schema is not revealed', async () => {
    const res = await post(JSON.stringify({ event: 'nonsense' }), { signed: false });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.details, undefined);
    assert.deepStrictEqual(touched, []);
});

// ═══ event ══════════════════════════════════════════════════════════

test('an event name outside the five is refused, not answered "ignored" under a 200', async () => {
    const res = await refuses({ event: 'user.delete', ncUid: 'alice', groupId: null }, 'body.event');
    assert.match(res.body.error, /user\.deleted/, 'the sentence lists what is accepted');
});

test('a missing event is refused by name, in the same sentence', async () => {
    const res = await refuses({ ncUid: 'alice' }, 'body.event');
    assert.match(res.body.error, /^event is one of /);
});

// ═══ ncUid ══════════════════════════════════════════════════════════

test('an ncUid that is an array is refused instead of reaching the sync', async () => {
    const res = await refuses({ event: 'user.deleted', ncUid: ['alice'], groupId: null }, 'body.ncUid');
    assert.strictEqual(res.body.error, 'ncUid is the Nextcloud user id, as text.');
});

test('a missing ncUid is refused in words, not with "Required"', async () => {
    const res = await refuses({ event: 'user.created', groupId: null }, 'body.ncUid');
    assert.strictEqual(res.body.error, 'ncUid is the Nextcloud user id, as text.');
});

test('an empty ncUid is refused the same way', async () => {
    await refuses({ event: 'user.created', ncUid: '', groupId: null }, 'body.ncUid');
});

// ═══ the rest of the body ═══════════════════════════════════════════

test('a key the connector never sends is refused', async () => {
    await refuses({ event: 'user.deleted', ncUid: 'alice', groupId: null, orgId: 'org2' }, 'body');
});

test('a group id that is not text is refused', async () => {
    await refuses({ event: 'group.member_added', ncUid: 'alice', groupId: 7 }, 'body.groupId');
});

// ═══ what the connector sends ═══════════════════════════════════════

test('a user deletion as the connector sends it still deactivates', async () => {
    const res = await post(JSON.stringify({ event: 'user.deleted', ncUid: 'alice', groupId: null }));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true, action: 'deactivate', userId: 'nc_org1_alice' });
    assert.deepStrictEqual(touched, [{ what: 'applyUserDeleted', args: ['org1', 'alice'] }]);
});

test('a group change as the connector sends it still reaches the sync with its group', async () => {
    const res = await post(JSON.stringify({ event: 'group.member_removed', ncUid: 'alice', groupId: 'sales' }));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(touched, [{ what: 'applyGroupMemberChange', args: ['org1', 'alice', 'sales'] }]);
});

test('user.updated still re-syncs the user through applyUserCreated', async () => {
    const res = await post(JSON.stringify({ event: 'user.updated', ncUid: 'alice', groupId: null }));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(touched, [{ what: 'applyUserCreated', args: ['org1', 'alice'] }]);
});

// ═══ replay ═════════════════════════════════════════════════════════

test('a captured user.deleted replayed inside the window is a 401 and does not reach the sync again', async () => {
    const raw = JSON.stringify({ event: 'user.deleted', ncUid: 'replayed-bob', groupId: null });
    const header = sign(raw);
    const first = await send(raw, header);
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(touched, [{ what: 'applyUserDeleted', args: ['org1', 'replayed-bob'] }]);

    touched.length = 0;
    const replay = await send(raw, header);
    assert.strictEqual(replay.status, 401);
    assert.deepStrictEqual(replay.body, { error: 'Invalid or missing signature' }, 'the same answer as any bad signature');
    assert.deepStrictEqual(touched, [], 'a replay must not deactivate anyone again');
});

test('re-casing the hex digest does not make a replay look new', async () => {
    const raw = JSON.stringify({ event: 'user.deleted', ncUid: 'recased-carol', groupId: null });
    const header = sign(raw);
    assert.strictEqual((await send(raw, header)).status, 200);
    touched.length = 0;
    const [ts, hex] = header.split('.');
    const res = await send(raw, `${ts}.${hex.toUpperCase()}`);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(touched, []);
});

test('a different event in the same second is still accepted', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const a = JSON.stringify({ event: 'user.created', ncUid: 'dave', groupId: null });
    const b = JSON.stringify({ event: 'group.member_added', ncUid: 'dave', groupId: 'sales' });
    assert.strictEqual((await send(a, sign(a, ts))).status, 200);
    assert.strictEqual((await send(b, sign(b, ts))).status, 200);
    assert.strictEqual(touched.length, 2);
});

// ═══ a failing lookup ═══════════════════════════════════════════════

test('an org lookup that throws is the same 401 as an unknown org, not a 500', async () => {
    const saved = lookupOrg;
    lookupOrg = async () => { throw new Error('db down'); };
    try {
        const res = await post(JSON.stringify({ event: 'user.deleted', ncUid: 'erin', groupId: null }));
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(touched, []);
    } finally {
        lookupOrg = saved;
    }
});
