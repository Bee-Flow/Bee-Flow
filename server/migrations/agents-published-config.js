/**
 * Migration: agents concept/live split (A1, 2026-09) — in TWO parts.
 *
 * Part 1 — `up()`: the columns.
 *   published_config JSONB, published_system_prompt TEXT,
 *   published_version INT DEFAULT 0, published_rev INT, published_at.
 *   Same DDL as stores/agent/initSchema.js (which runs at boot), so both paths
 *   are idempotent and either may run first. Adding the columns changes
 *   NOTHING for anyone: published_version stays 0, published_* stays NULL and
 *   agentStore.getForRuntime keeps serving the concept.
 *
 * Part 2 — `backfillPublished()`: flip existing agents into split mode by
 *   copying their current concept into published_* and setting
 *   published_version := 1, published_rev := rev.
 *
 *   DELIBERATELY NOT WIRED INTO BOOT. Once an agent is in split mode, only
 *   POST /agents/:id/publish-version reaches users — and until the A2 editor
 *   header ships that button, every other writer (the legacy editors
 *   AgentDesignerPanel / useAgentApi, version restore, the support singleton
 *   PUT) would keep writing a concept nobody can publish. The backfill runs in
 *   the same release as that header (plan: step 4 = the A2 stage), by hand:
 *
 *     node migrations/agents-published-config.js --backfill --dry-run   # counts only
 *     node migrations/agents-published-config.js --backfill             # writes
 *
 *   Never backfilled: owner_id IN ('system','swarm') — the support singleton
 *   and system agents have no publish button and always follow live (the
 *   store refuses them too). Idempotent: WHERE published_version = 0, so a
 *   second run is a no-op and an agent published in between is left alone.
 *   Rows whose config is not valid JSON are published as `{}` and listed in
 *   the result so someone can look at them.
 */

const { exec, getAll, run } = require('../db');

async function up() {
    await exec(`ALTER TABLE agents
        ADD COLUMN IF NOT EXISTS published_config JSONB,
        ADD COLUMN IF NOT EXISTS published_system_prompt TEXT,
        ADD COLUMN IF NOT EXISTS published_version INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS published_rev INTEGER,
        ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`);
    console.log('[Migration] agents-published-config: columns ensured (no backfill — see header)');
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] Count candidates, write nothing.
 * @returns {Promise<{dryRun:boolean, candidates:number, updated:number, invalidConfig:string[]}>}
 */
async function backfillPublished({ dryRun = false } = {}) {
    const rows = await getAll(`
        SELECT id, config, rev
          FROM agents
         WHERE owner_id NOT IN ('system', 'swarm')
           AND published_version = 0
           AND published_config IS NULL
         ORDER BY id
    `);
    const result = { dryRun: !!dryRun, candidates: rows.length, updated: 0, invalidConfig: [] };
    for (const row of rows) {
        let cfg = {};
        if (row.config && typeof row.config === 'object') {
            cfg = row.config;
        } else if (typeof row.config === 'string' && row.config.trim()) {
            try { cfg = JSON.parse(row.config) || {}; } catch (_) { cfg = {}; result.invalidConfig.push(row.id); }
        }
        if (dryRun) continue;
        // Guard on published_version AND rev: a concept saved after the SELECT
        // is not silently frozen at the older snapshot — the row is skipped and
        // the next run picks it up.
        const res = await run(`
            UPDATE agents
               SET published_config = $1::jsonb,
                   published_system_prompt = system_prompt,
                   published_version = 1,
                   published_rev = rev,
                   published_at = NOW()
             WHERE id = $2
               AND rev = $3
               AND published_version = 0
               AND owner_id NOT IN ('system', 'swarm')
        `, [JSON.stringify(cfg), row.id, Number(row.rev) || 1]);
        result.updated += res?.rowCount ?? 0;
    }
    console.log(`[Migration] agents-published-config backfill${dryRun ? ' (dry-run)' : ''}: ${result.candidates} candidate(s), ${result.updated} updated`);
    return result;
}

module.exports = { up, backfillPublished };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes('--dry-run');
    const doBackfill = argv.includes('--backfill');
    (async () => {
        if (!dryRun) await up();
        if (doBackfill) {
            const r = await backfillPublished({ dryRun });
            console.log(JSON.stringify(r));
        } else {
            console.log('[Migration] pass --backfill to copy concepts into published_* (add --dry-run to only count)');
        }
    })().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
