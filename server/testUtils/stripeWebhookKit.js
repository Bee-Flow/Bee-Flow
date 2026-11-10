// @typecheck strict
/**
 * The Stripe webhook route (routes/stripe/webhook.js) against the REAL stores
 * on PGlite, for a test of what an event leaves behind: the subscription row,
 * the audit rows, the idempotency ledger and the mail that went out.
 *
 *   const kit = stripeWebhookKit();
 *   before(kit.init); after(kit.close);
 *   const res = await kit.deliver('invoice.payment_failed', { id: 'in_1', subscription: 'sub_A' });
 *
 * Three seams, all on objects the product shares (testUtils/swaps.js): the
 * signature check of stripeService answers the event `deliver` was given, the
 * billing mails of utils/emailService are collected in `mails` instead of
 * sent, and `failWrites(/regex/)` makes the pool refuse the statements that
 * match, the way a database error would.
 */

'use strict';

const { usePglitePool } = require('./pglitePool');
const { makeSwaps } = require('./swaps');
const h = require('./routeHarness');

const BILLING_MAILS = ['sendPaymentFailedEmail', 'sendSubscriptionSuspendedEmail', 'sendSubscriptionConfirmationEmail', 'sendTrialEndingEmail', 'sendSubscriptionStartedAdminEmail'];
const TABLES = ['organization_subscriptions', 'consumer_subscriptions', 'subscription_audit_log', 'notifications_sent', 'stripe_processed_events'];

/**
 * @typedef {Record<string, unknown>} Row
 * @typedef {(sql: string | { text?: string }, params?: unknown[]) => Promise<unknown>} Query
 * @typedef {{ query: Query, connect: () => Promise<{ query: Query, release: () => void }> }} PoolSeam
 */

function stripeWebhookKit() {
    const { pg, query, close: closePool } = usePglitePool();
    const pool = /** @type {PoolSeam} */ (/** @type {unknown} */ (require('../db').pool));
    const stripeService = require('../services/stripeService');
    const emailService = require('../utils/emailService');
    const { swap, restore } = makeSwaps();

    /** @type {RegExp | null} */
    let refused = null;
    /** @type {Query} */
    const guarded = async (sql, params) => {
        const text = typeof sql === 'string' ? sql : String(sql?.text || '');
        if (refused && refused.test(text)) throw new Error('simulated database failure');
        return query(sql, params);
    };
    pool.query = guarded;
    pool.connect = async () => ({ query: guarded, release() {} });

    /** @type {Row[]} */
    const mails = [];
    /** @type {unknown} */
    let nextEvent = null;
    let seq = 0;
    swap(stripeService, 'constructWebhookEvent', async () => nextEvent);
    swap(stripeService, 'createPortalSession', async () => ({ url: 'https://billing.example.test/portal' }));
    for (const name of BILLING_MAILS) {
        swap(emailService, name, async (/** @type {Row} */ args) => { mails.push({ mail: name, ...args }); return { success: true }; });
    }

    const api = h.serve('/', require('../routes/stripe/webhook'));

    /**
     * Deliver one event; the same `id` again is a redelivery of it.
     * @param {string} type
     * @param {Row} payload  the event's `data.object`
     * @param {string} [id]
     */
    async function deliver(type, payload, id = `evt_${++seq}`) {
        nextEvent = { id, type, data: { object: payload } };
        const res = await api.call('POST', '/webhook', { body: {}, headers: { 'stripe-signature': 'sig_test' } });
        return { ...res, eventId: id };
    }

    /**
     * @param {string} sql
     * @param {unknown[]} [params]
     * @returns {Promise<Row[]>}
     */
    const rows = async (sql, params = []) => /** @type {Row[]} */ ((await pg.query(sql, params)).rows);
    /** @param {string} table @param {string} col */
    const rowOf = (table, col) => async (/** @type {string} */ id) => (await rows(`SELECT * FROM ${table} WHERE ${col} = $1`, [id]))[0];

    return {
        pg, mails, deliver, swap,
        init: () => require('../stores/user/schema').initDB(),
        /** Refuse every statement matching `re` until `failWrites(null)`. */
        failWrites: (/** @type {RegExp | null} */ re) => { refused = re; },
        orgSub: rowOf('organization_subscriptions', 'organization_id'),
        consumerSub: rowOf('consumer_subscriptions', 'user_id'),
        /** The audit actions written for a target, sorted. */
        audits: async (/** @type {string} */ targetId) => (await rows('SELECT action FROM subscription_audit_log WHERE target_id = $1 ORDER BY action', [targetId])).map((r) => r.action),
        /** Whether the ledger holds the event as processed. */
        processed: async (/** @type {string} */ eventId) => (await rows('SELECT 1 FROM stripe_processed_events WHERE event_id = $1', [eventId])).length > 0,
        async reset() {
            refused = null;
            mails.length = 0;
            for (const t of TABLES) await pg.query(`DELETE FROM ${t}`);
        },
        async close() {
            restore();
            await api.close();
            await closePool();
        },
    };
}

module.exports = { stripeWebhookKit };
