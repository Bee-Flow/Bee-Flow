// @typecheck strict
/**
 * Migration: the signing secret of an automation webhook is sealed at rest (2026-11).
 *
 * `automation_webhooks.secret` keeps its name and now holds the secret sealed
 * (stores/configEncryption.js, under the organisation of the automation, or the
 * default context for an automation without one). This pass seals, in place, every
 * value that is not sealed yet. The store reads both forms
 * (stores/automationStore/webhooks.js), so a sender notices nothing: the secret a
 * sender holds is the same before and after.
 *
 * Idempotent, and it runs on every boot: a sealed value is left alone, so the second
 * run finds nothing. Safe with two instances at once: a row is written only while it
 * still holds the value that was read, so of two passes one seals it and the other
 * changes nothing. A value that cannot be sealed (no master key) stays as it is and
 * the pass says so; the next boot tries again.
 */

/** @typedef {{ id: string, secret: string, organization_id: string | null }} Row */

/** @param {unknown} stored */
function isSealed(stored) {
    if (typeof stored !== 'string' || !stored.startsWith('{')) return false;
    try {
        return JSON.parse(stored)?._encrypted === 'config-v1';
    } catch {
        return false;
    }
}

/**
 * @param {{
 *   getAll?: (sql: string, params?: unknown[]) => Promise<Row[]>,
 *   run?: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null }>,
 *   seal?: (secret: string, orgId: string | null) => string,
 * }} [opts]
 */
async function up({
    getAll = (sql, params) => require('../db').getAll(sql, params),
    run = (sql, params) => require('../db').run(sql, params),
    seal = (secret, orgId) => String(require('../stores/configEncryption').encryptValue(secret, /** @type {any} */ (orgId))),
} = {}) {
    const rows = await getAll(
        `SELECT w.id, w.secret, a.organization_id
           FROM automation_webhooks w LEFT JOIN automations a ON a.id = w.automation_id
          WHERE w.secret NOT LIKE '{%'`,
    );
    let sealed = 0;
    for (const row of rows) {
        if (!row.secret || isSealed(row.secret)) continue;
        const value = seal(row.secret, row.organization_id || null);
        const res = await run(`UPDATE automation_webhooks SET secret = $1 WHERE id = $2 AND secret = $3`, [value, row.id, row.secret]);
        sealed += res?.rowCount ?? 0;
    }
    if (sealed) console.log(`[Migration] automation-webhook-secret-sealed-2026-11: ${sealed} webhook secret${sealed === 1 ? '' : 's'} sealed`);
    return sealed;
}

module.exports = { up, isSealed };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
