/**
 * Migration: the two halves of extending the response cache to http_request
 * (2026-09).
 *
 * 1. `integration_activity_log.served_from_cache`. The ledger is the ONLY
 *    evidence an organisation ever talked to a given processor, and a durable
 *    cache hit means no bytes crossed the boundary. A synthetic egress row
 *    would assert a transfer that did not happen and inflate the Art-44 count;
 *    writing nothing would erase a processor from the Art-30 register once a
 *    cross-run hit answers every call for a day. So: a flag, never a synthetic
 *    row. The Art-44 transfer check EXCLUDES flagged rows; the RoPA processor
 *    register and its MAX(timestamp) INCLUDE them.
 *
 * 2. `scopes` on every org that already opted into the durable cache. The
 *    consent they gave was "answers from an APP look-up may be stored"; this
 *    release adds arbitrary outbound HTTP to the same key, and that is a wider
 *    promise than the one they made. `{integration: true, http: false}` is the
 *    honest translation of the row they already have — and it matches what
 *    integrationCachePolicy.normalizeScopes derives for an unstamped row, so a
 *    replica reading one before this lands behaves identically.
 *
 * Idempotent: the column is IF NOT EXISTS and the config rewrite skips any row
 * that already carries `scopes`.
 */

const { exec, getAll, run } = require('../db');

const CONFIG_KEY_PREFIX = 'org_integration_cache_';

async function up() {
    // NOT NULL DEFAULT false rather than a nullable flag: every reader below
    // filters on it, and `served_from_cache IS NOT TRUE` on a nullable column
    // is the kind of three-valued clause that silently drops rows from a count
    // an auditor reads.
    await exec(`
        ALTER TABLE integration_activity_log
            ADD COLUMN IF NOT EXISTS served_from_cache BOOLEAN NOT NULL DEFAULT false
    `);

    // Parsed in JS, not with `value::jsonb`: the config column is TEXT and a
    // single non-JSON row anywhere under this prefix would abort the whole
    // statement. One skipped row must never cost the other orgs their stamp.
    let rows = [];
    try {
        rows = await getAll(`SELECT key, value FROM config WHERE key LIKE $1`, [`${CONFIG_KEY_PREFIX}%`]);
    } catch (_) {
        // Fresh install — no config table yet, and therefore no org that opted in.
        return;
    }

    let stamped = 0;
    for (const row of rows || []) {
        let blob;
        try { blob = JSON.parse(row.value); } catch (_) { continue; }
        if (!blob || typeof blob !== 'object' || Array.isArray(blob)) continue;
        // Only orgs that actually said yes. A row that is off carries no
        // consent to translate, and normalizeScopes gives it the same answer.
        if (blob.enabled !== true) continue;
        if (blob.scopes && typeof blob.scopes === 'object') continue;
        blob.scopes = { integration: true, http: false };
        await run(`UPDATE config SET value = $2, updated_at = NOW() WHERE key = $1`,
            [row.key, JSON.stringify(blob)]);
        stamped++;
    }
    if (stamped) console.log(`[Migration] integration-cache-scopes-2026-09: stamped ${stamped} opted-in org(s) with scopes`);
}

module.exports = { up, CONFIG_KEY_PREFIX };
