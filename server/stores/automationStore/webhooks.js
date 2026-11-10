// @typecheck strict
/**
 * webhooks.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll } = require('./core');
const { rowToAutomation } = require('./rowMappers');
const { bestEffort } = require('../../utils/bestEffort');

// ── Webhooks ──────────────────────────────────────────

/**
 * @param {string} automationId
 * @param {string | null} [triggerStepId]
 */
async function createWebhook(automationId, triggerStepId = null) {
    await initDB();
    // WS5.1 — the slug is the only auth on /webhook/:slug, so give new ones
    // 192 bits of entropy (was 96). Both lengths stay valid: TEXT PK with
    // exact lookup, so pre-existing 24-hex slugs keep working.
    const id = crypto.randomBytes(24).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    await run(
        `INSERT INTO automation_webhooks (id, automation_id, secret, trigger_step_id) VALUES ($1, $2, $3, $4)`,
        [id, automationId, secret, triggerStepId],
    );
    return { id, automationId, secret, triggerStepId };
}

/** @param {string} id */
async function getWebhook(id) {
    await initDB();
    const r = await getOne('SELECT * FROM automation_webhooks WHERE id = $1', [id]);
    if (!r) return null;
    return { id: r.id, automationId: r.automation_id, secret: r.secret, allowMethods: r.allow_methods, lastSeenAt: r.last_seen_at, triggerStepId: r.trigger_step_id ?? null };
}

/** @param {string} automationId */
async function getWebhooksForAutomation(automationId) {
    await initDB();
    const rows = await getAll('SELECT id, automation_id, allow_methods, last_seen_at, created_at, trigger_step_id FROM automation_webhooks WHERE automation_id = $1', [automationId]);
    return rows.map(r => ({ id: r.id, automationId: r.automation_id, allowMethods: r.allow_methods, lastSeenAt: r.last_seen_at, createdAt: r.created_at, triggerStepId: r.trigger_step_id ?? null }));
}

/** @param {string} id */
async function touchWebhook(id) {
    await initDB();
    await run(`UPDATE automation_webhooks SET last_seen_at = NOW() WHERE id = $1`, [id]);
}

/**
 * Rotate the HMAC secret for a webhook. The webhook's URL stays the same;
 * only the secret used for signature verification changes — so any caller
 * still using the old secret immediately starts getting 401s, while a
 * newly-issued secret takes effect on the next inbound request.
 * @param {string} webhookId
 * @param {string} automationId
 */
async function rotateWebhookSecret(webhookId, automationId) {
    await initDB();
    const newSecret = crypto.randomBytes(32).toString('hex');
    const { rowCount } = await run(
        `UPDATE automation_webhooks
            SET secret = $1
          WHERE id = $2 AND automation_id = $3`,
        [newSecret, webhookId, automationId],
    );
    if (rowCount === 0) return null;
    return { id: webhookId, automationId, secret: newSecret };
}

/**
 * @param {string} webhookId
 * @param {string} automationId
 */
async function deleteWebhook(webhookId, automationId) {
    await initDB();
    const { rowCount } = await run(
        `DELETE FROM automation_webhooks WHERE id = $1 AND automation_id = $2`,
        [webhookId, automationId],
    );
    return rowCount > 0;
}

// Nonces under this prefix outlive the 24 h sweep (see checkAndStoreNonce).
const RETAINED_PREFIX = 'keep:';

/**
 * Days a retained nonce is kept (WEBHOOK_UNTIMED_NONCE_RETENTION_DAYS); 0 or
 * unset keeps it for good.
 */
function retainedNonceDays() {
    const n = Number(process.env.WEBHOOK_UNTIMED_NONCE_RETENTION_DAYS);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Record a nonce; false when it was seen before.
 *
 * Ordinary nonces are swept after 24 h. `retain` is for a delivery whose
 * signature carries no timestamp: such a request stays valid indefinitely,
 * so its nonce is kept as long as the request could be sent again (until
 * WEBHOOK_UNTIMED_NONCE_RETENTION_DAYS, when the operator sets one).
 * @param {string} nonce
 * @param {{ retain?: boolean }} [options]
 */
async function checkAndStoreNonce(nonce, { retain = false } = {}) {
    await initDB();
    // Garbage-collect old nonces opportunistically.
    await run(`DELETE FROM automation_webhook_seen_nonces WHERE seen_at < NOW() - INTERVAL '24 hours' AND nonce NOT LIKE '${RETAINED_PREFIX}%'`).catch((e) => bestEffort('automationStore/webhooks:nonceGc', e));
    const days = retainedNonceDays();
    if (days > 0) {
        await run(
            `DELETE FROM automation_webhook_seen_nonces WHERE nonce LIKE '${RETAINED_PREFIX}%' AND seen_at < NOW() - ($1::int * INTERVAL '1 day')`,
            [days],
        ).catch((e) => bestEffort('automationStore/webhooks:retainedNonceGc', e));
    }
    if (retain) {
        // The same nonce stored before it was kept under the prefix.
        const earlier = await getOne(`SELECT 1 AS hit FROM automation_webhook_seen_nonces WHERE nonce = $1`, [nonce]);
        if (earlier) return false;
    }
    try {
        await run(`INSERT INTO automation_webhook_seen_nonces (nonce) VALUES ($1)`, [retain ? RETAINED_PREFIX + nonce : nonce]);
        return true;
    } catch (e) {
        // Only the primary-key violation means "seen before". Any other
        // failure (an outage, a missing table) is not a replay: answering
        // false would refuse a genuine delivery with a 401 its sender does not
        // retry, where an error makes it send the delivery again.
        if (/** @type {{ code?: string }} */ (e)?.code === '23505') return false;
        throw e;
    }
}

/**
 * The live (active, not trashed) automations of one organisation, newest first:
 * the candidates an admin can enable for website forms. `organizationId` null
 * matches automations that carry no organisation. Capped; the caller narrows
 * to those with a webhook trigger.
 * @param {string | null} organizationId
 */
async function listActiveAutomationsOfOrg(organizationId) {
    await initDB();
    const rows = await getAll(
        `SELECT a.* FROM automations a
          WHERE a.organization_id IS NOT DISTINCT FROM $1
            AND COALESCE(a.kind, 'automation') = 'automation'
            AND a.deleted_at IS NULL AND a.is_active = TRUE AND a.is_draft = FALSE
          ORDER BY a.updated_at DESC LIMIT 500`,
        [organizationId || null],
    );
    return rows.map(rowToAutomation);
}

module.exports = { listActiveAutomationsOfOrg, createWebhook, getWebhook, getWebhooksForAutomation, touchWebhook, rotateWebhookSecret, deleteWebhook, checkAndStoreNonce };
