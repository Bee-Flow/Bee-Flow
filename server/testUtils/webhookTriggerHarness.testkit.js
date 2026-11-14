// @typecheck
'use strict';

/**
 * The set-up the webhook-trigger tests share (appStudio/triggers/webhook/*.test.js, the inbound
 * route): the trigger harness (real run and trigger stores on PGlite, a fake clock) plus the REAL
 * webhook store on the same database, a seal that is plain to read in a test, and a sender that
 * signs deliveries the way the recipe says.
 *
 *   w.limits      webhookLimits({}), a copy a test may change
 *   publish(def)  publish and give the webhook triggers their endpoints, as the publish route does
 *   endpoint(id)  the endpoint row of a trigger; secret(id) reveals its secret
 *   signed(body, over)   a delivery signed with `over.secret` (default: the trigger's own)
 *   receive(delivery)    the receive with the harness's deps
 */

const { triggerHarness } = require('./triggerHarness.testkit');
const { studioRunTableDdl } = require('./studioRunTables');
const { makeWebhookTriggerStore } = require('../stores/studioAppData/webhookTriggers.mts');
const { webhookLimits } = require('../stores/studioAppData/webhookPolicy.mts');
const endpoints = require('../appStudio/triggers/webhook/webhookEndpoints.mts');
const { receiveWebhook, _resetRefusedLog } = require('../appStudio/triggers/webhook/webhookReceive.mts');
const { hmacHeader, sameSignature } = require('../usecases/automation/webhookSignature');

const SEAL = 'sealed:';
const seal = (secret) => SEAL + Buffer.from(secret).toString('base64');
const open = (cipher) => (typeof cipher === 'string' && cipher.startsWith(SEAL) ? Buffer.from(cipher.slice(SEAL.length), 'base64').toString() : null);

/** A webhook trigger for the harness's `act_job`. */
const hook = (over = {}) => ({ id: 'hook', kind: 'webhook', actionId: 'act_job', auth: 'hmac', ...over });

function webhookHarness(hooks) {
    const h = triggerHarness(hooks);
    const store = makeWebhookTriggerStore(h.db);
    const w = { limits: /** @type {ReturnType<typeof webhookLimits>} */ ({}), n: 0, taken: new Map() };
    const quiet = { info() {}, warn() {}, error() {} };

    hooks.before(async () => { await h.pg.exec(studioRunTableDdl('studio_app_webhook_endpoints')); });
    hooks.beforeEach(async () => {
        await h.pg.query('DELETE FROM studio_app_webhook_endpoints');
        _resetRefusedLog();
        Object.assign(w, { limits: { ...webhookLimits({}) }, n: 0, taken: new Map() });
    });

    const hex = (n, length) => n.toString(16).padStart(length, '0');
    const endpointDeps = () => ({
        store: () => store, getApp: h.identity().getApp, seal, open,
        newEndpointId: () => hex(++w.n, 48), newSecret: () => `secret-${hex(++w.n, 8)}`,
        now: () => h.s.clock, limits: () => w.limits, log: quiet,
    });
    const receiveDeps = (over = {}) => ({
        store: () => store, triggers: () => h.triggers, open, sign: hmacHeader, same: sameSignature,
        take: async (key, max) => {
            const used = (w.taken.get(key) || 0) + 1;
            w.taken.set(key, used);
            return !max || used <= max ? { ok: /** @type {const} */ (true) } : { ok: /** @type {const} */ (false), retryAfterSecs: 30 };
        },
        fire: () => h.fireDeps(), now: () => h.s.clock, limits: () => w.limits,
        newDeliveryId: () => `whd_${hex(++w.n, 32)}`, log: quiet,
        ...over,
    });

    async function publish(def) {
        const out = await h.publish(def);
        await endpoints.syncWebhookEndpoints(h.t.app.id, endpointDeps());
        return out;
    }
    const endpoint = (triggerId = 'hook') => store.endpointFor('app_1', triggerId);
    /** The trigger's secret in clear, read from the row (the reveal is a test of its own). */
    const secret = async (triggerId = 'hook') => open((await endpoint(triggerId)).secretCipher);

    /** A delivery of `body` (an object, or the exact text) as a sender signs it. */
    async function signed(body, over = {}) {
        const row = over.endpointId ? null : await endpoint(over.triggerId);
        const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const timestamp = String(over.timestamp ?? Math.floor(h.s.clock / 1000));
        const nonce = over.nonce ?? `delivery-${++w.n}`;
        const key = over.secret ?? (row ? open(row.secretCipher) : 'no-secret');
        return {
            endpointId: over.endpointId ?? row.endpointId, timestamp, nonce, rawBody: raw,
            signature: over.signature ?? hmacHeader(key, `${nonce}\n${timestamp}\n${raw.toString('utf8')}`),
            headers: { 'content-type': 'application/json', ...(over.headers || {}) },
        };
    }
    const receive = (delivery, over) => receiveWebhook(delivery, receiveDeps(over));
    const deliveries = async (triggerId = 'hook') => (await store.listDeliveries((await endpoint(triggerId)).endpointId, 100)).reverse();

    return { ...h, w, hooks: store, endpointDeps, receiveDeps, publish, endpoint, secret, signed, receive, deliveries, hook, seal, open, endpoints };
}

module.exports = { webhookHarness };
