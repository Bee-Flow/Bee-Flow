'use strict';

/**
 * POST /api/automation/events/nextcloud routes an approval reaction — and
 * routes NOTHING it cannot authenticate.
 *
 * The endpoint already existed for Nextcloud triggers; approval-by-reaction
 * rides the SAME signed event rather than opening a second door. Two things
 * have to stay true:
 *
 *   • the tenant-key HMAC is checked BEFORE anything is acted on, so an
 *     unsigned or tampered body can never reach the decision path (this is the
 *     outermost of the two signatures — Talk's own bot signature is verified
 *     first, in the connector, against the bot secret);
 *   • the existing trigger dispatch is untouched: a routine subscribed to
 *     talk.reaction.added still fires exactly as before, additively.
 *
 * Handler invoked directly with mocked stores — the harness family of
 * events.webhookPayload.test.js.
 *
 * Run: cd server && node --test --test-force-exit routes/automation/events.reactionRouting.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

const TENANT_KEY = 'tenant-key-'.repeat(4);
const rec = { dispatched: [], reactions: [] };

mock(path.join(SERVER, 'stores/automationStore'), {
    getSubscriptionsForUserAndEvent: async () => [],
    updateSubscription: async () => {},
});
mock(path.join(SERVER, 'stores/configStore'), {
    getSecret: async (key) => (key === 'connector_tenant_key_org1' ? TENANT_KEY : null),
});
mock(path.join(SERVER, 'automation/triggerBus'), {
    dispatchEvent: async (e) => { rec.dispatched.push(e); return []; },
});
mock(path.join(SERVER, 'stores/userStore'), {
    getOrganizationByNcInstanceId: async (id) => (id === 'inst-1' ? { id: 'org1' } : null),
    getUserByNcUid: async () => ({ id: 'u_lead' }),
});
mock(path.join(SERVER, 'automation/approvalReactionIngest'), {
    handleTalkReaction: async (args) => { rec.reactions.push(args); return { counted: true, outcome: 'vote_recorded' }; },
});

const eventsRouter = require('./events');

function findHandler(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
const handler = findHandler(eventsRouter, 'post', '/events/nextcloud');

function makeRes() {
    const res = { statusCode: 200, body: null, ended: false };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.end = () => { res.ended = true; return res; };
    return res;
}

const URL_PATH = '/api/automation/events/nextcloud';

function signedReq(body, { key = TENANT_KEY, instance = 'inst-1', ts = Math.floor(Date.now() / 1000) } = {}) {
    const raw = JSON.stringify(body);
    const sig = crypto.createHmac('sha256', key).update(`${ts}\nPOST\n${URL_PATH}\n${raw}`).digest('hex');
    return {
        method: 'POST',
        originalUrl: URL_PATH,
        ip: '10.0.0.1',
        rawBody: raw,
        body,
        headers: {
            'content-type': 'application/json',
            'x-beeflow-nc-instance-id': instance,
            'x-beeflow-sig': `${ts}.${sig}`,
        },
        get(name) { return this.headers[String(name).toLowerCase()]; },
    };
}

/** The route hands the reaction off with setImmediate; let the queue drain. */
async function drain() {
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
}

const REACTION = {
    event: 'talk.reaction.added',
    ncUid: 'ada',
    payload: { roomToken: 'room1', messageId: '1567', reaction: '👍', removed: false, actorType: 'users' },
};

test('a signed talk.reaction.added reaches the approval ingest', async () => {
    rec.dispatched = []; rec.reactions = [];
    const res = makeRes();
    await handler(signedReq(REACTION), res);
    await drain();

    assert.equal(res.statusCode, 202);
    assert.equal(rec.reactions.length, 1);
    assert.equal(rec.reactions[0].orgId, 'org1', 'the org comes from the verified signature, never the body');
    assert.equal(rec.reactions[0].ncUid, 'ada');
    assert.equal(rec.reactions[0].payload.messageId, '1567');
});

test('the existing trigger dispatch is untouched — the ingest is additive', async () => {
    rec.dispatched = []; rec.reactions = [];
    await handler(signedReq(REACTION), makeRes());
    await drain();
    assert.equal(rec.dispatched.length, 1);
    assert.equal(rec.dispatched[0].event, 'talk.reaction.added');
    assert.equal(rec.dispatched[0].provider, 'nextcloud');
    assert.equal(rec.dispatched[0].orgId, 'org1');
});

test('a tampered body never reaches the decision path', async () => {
    rec.dispatched = []; rec.reactions = [];
    const req = signedReq(REACTION);
    req.rawBody = JSON.stringify({ ...REACTION, ncUid: 'attacker' });   // signature now covers the old bytes
    const res = makeRes();
    await handler(req, res);
    await drain();
    assert.equal(res.statusCode, 401);
    assert.equal(rec.reactions.length, 0);
    assert.equal(rec.dispatched.length, 0);
});

test('a wrong tenant key is rejected', async () => {
    rec.dispatched = []; rec.reactions = [];
    const res = makeRes();
    await handler(signedReq(REACTION, { key: 'not-the-key'.repeat(4) }), res);
    await drain();
    assert.equal(res.statusCode, 401);
    assert.equal(rec.reactions.length, 0);
});

test('an unknown Nextcloud instance is rejected', async () => {
    rec.reactions = [];
    const res = makeRes();
    await handler(signedReq(REACTION, { instance: 'inst-unknown' }), res);
    await drain();
    assert.equal(res.statusCode, 401);
    assert.equal(rec.reactions.length, 0);
});

test('a replayed signature outside the skew window is rejected', async () => {
    rec.reactions = [];
    const res = makeRes();
    await handler(signedReq(REACTION, { ts: Math.floor(Date.now() / 1000) - 3600 }), res);
    await drain();
    assert.equal(res.statusCode, 401);
    assert.equal(rec.reactions.length, 0);
});

test('other Nextcloud events do not touch the approval path', async () => {
    rec.dispatched = []; rec.reactions = [];
    await handler(signedReq({
        event: 'talk.message.received', ncUid: 'ada',
        payload: { roomToken: 'room1', messageId: '1568', message: 'hello' },
    }), makeRes());
    await drain();
    assert.equal(rec.dispatched.length, 1);
    assert.equal(rec.reactions.length, 0);
});

test('an ingest failure never fails the ack — Talk marks a slow bot unhealthy', async () => {
    rec.reactions = [];
    const ingestPath = require.resolve(path.join(SERVER, 'automation/approvalReactionIngest'));
    const saved = require.cache[ingestPath].exports.handleTalkReaction;
    require.cache[ingestPath].exports.handleTalkReaction = async () => { throw new Error('boom'); };
    const res = makeRes();
    await handler(signedReq(REACTION), res);
    await drain();
    assert.equal(res.statusCode, 202);
    require.cache[ingestPath].exports.handleTalkReaction = saved;
});
