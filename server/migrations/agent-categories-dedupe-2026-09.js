/**
 * Migration: merge case-insensitive duplicate agent categories, then build the
 * unique index that could not be built over them.
 *
 * BFSF-272 added `idx_agent_categories_org_lname` to the agent schema
 * (stores/agent/initSchema.js): one category name per org, compared with
 * LOWER(). Installs that already held "Sales" next to "sales" fail that
 * CREATE UNIQUE INDEX with 23505 on every boot. runDdl reports it and carries
 * on, so the app works, but the duplicates stay and nothing stops new ones
 * except the idempotent POST /agents/categories.
 *
 * Decision (owner, 2026-09): merge each duplicate group into its OLDEST row,
 * exactly the way the merge UI does it (DELETE /agents/categories/:id
 * ?reassignTo=<keeper>): re-point the agents with the same statement as
 * agentCrud.reassignAgentsCategory (it bumps `rev`, so an open editor
 * reconciles through the 409 flow instead of saving a stale category), then
 * delete the duplicate row.
 *
 * "Oldest" is `created_at`, then `id` as the tiebreak. created_at is nullable
 * (DEFAULT NOW(), no NOT NULL), so a row without one sorts last: a row whose
 * age is known wins over one whose age is not.
 *
 * Groups are keyed on (COALESCE(organization_id,''), LOWER(name)), the index
 * expression itself, so the grouping agrees with the index about what a
 * duplicate is: the NULL org and '' share one bucket, and LOWER() is the
 * database's, not JavaScript's.
 *
 * Everything happens in ONE transaction: the table lock, the merge and the
 * index. With the index inside the same transaction there is no window in
 * which a new duplicate can land between the merge and the index build, and a
 * failure anywhere rolls the whole run back.
 *
 * Idempotent: once the index exists there are no groups, and a second run
 * changes nothing. Registered in boot/bootMigrations.js LOOSE_MIGRATIONS.
 *
 * Standalone: node migrations/agent-categories-dedupe-2026-09.js [--dry-run]
 */

'use strict';

const agentSchema = require('../stores/agent/initSchema');

const NAME = 'agent-categories-dedupe-2026-09';

// The boot DDL's own statement, not a copy: an index with the same name but a
// different definition would make IF NOT EXISTS skip the boot version for good.
const INDEX_SQL = agentSchema.AGENT_CATEGORY_NAME_INDEX_SQL;

// The same statement as agentCrud.reassignAgentsCategory.
const REASSIGN_SQL = 'UPDATE agents SET category_id = $2, rev = rev + 1, updated_at = NOW() WHERE category_id = $1';

// Every row of every duplicate group, keeper first within its group.
const GROUPS_SQL = `
    WITH dup AS (
        SELECT COALESCE(organization_id,'') AS org_key, LOWER(name) AS lname
          FROM agent_categories
         GROUP BY 1, 2
        HAVING COUNT(*) > 1
    )
    SELECT c.id, c.organization_id, d.org_key, d.lname,
           (SELECT COUNT(*)::int FROM agents a WHERE a.category_id = c.id) AS agent_count
      FROM agent_categories c
      JOIN dup d ON d.org_key = COALESCE(c.organization_id,'') AND d.lname = LOWER(c.name)
     ORDER BY d.org_key, d.lname, c.created_at ASC NULLS LAST, c.id ASC`;

function groupRows(rows) {
    const groups = [];
    let current = null;
    for (const r of rows) {
        if (!current || current.orgKey !== r.org_key || current.lname !== r.lname) {
            current = {
                orgKey: r.org_key,
                orgId: r.organization_id || null,
                lname: r.lname,
                keepId: r.id,
                dropIds: [],
                agentCount: 0,
            };
            groups.push(current);
            continue;
        }
        current.dropIds.push(r.id);
        current.agentCount += Number(r.agent_count) || 0;
    }
    return groups;
}

function describe(g) {
    return `org=${g.orgKey || '(global)'} name="${g.lname}" keep=${g.keepId} `
        + `drop=[${g.dropIds.join(', ')}] agents=${g.agentCount}`;
}

async function hasSchema(db) {
    const row = await db.getOne(`
        SELECT to_regclass('agent_categories') IS NOT NULL AS has_categories,
               EXISTS (
                   SELECT 1 FROM pg_attribute
                    WHERE attrelid = to_regclass('agents')
                      AND attname = 'category_id' AND NOT attisdropped
               ) AS has_category_id,
               EXISTS (
                   SELECT 1 FROM pg_attribute
                    WHERE attrelid = to_regclass('agents')
                      AND attname = 'rev' AND NOT attisdropped
               ) AS has_rev`);
    return {
        ok: !!(row?.has_categories && row?.has_category_id && row?.has_rev),
        row,
    };
}

/**
 * @param {{ dryRun?: boolean, db?: object, initSchema?: () => Promise<unknown> }} [opts]
 *        `db` and `initSchema` are injection seams for the integration test;
 *        the boot ladder calls up() without arguments and gets the real ones.
 * @returns {Promise<{ groups: number, removed: number, agentsMoved: number, dryRun: boolean, skipped?: string }>}
 */
async function up({ dryRun = false, db = null, initSchema = null } = {}) {
    // Unlike cowork-shield-flag, which logs and returns 0, a failure here is
    // rethrown. There a swallowed failure is harmless: the reader's default
    // keeps behaviour identical until the next boot. Here, runList would record
    // a swallowed failure in the schema_migrations ledger as applied, the
    // ledger skips an unchanged file, and the duplicates and the missing index
    // would stay forever. A throw keeps the entry out of the ledger, so the
    // next boot retries; the single transaction guarantees the failed run left
    // nothing half done.
    try {
        const facade = db || require('../db');

        // The table and the columns this merge writes belong to the agent
        // schema. Boot runs the loose migrations next to the store inits, so
        // wait for that schema; its init is memoised, so this is the same
        // promise the boot already started, not a second run.
        await (initSchema || agentSchema.initDB)();

        const schema = await hasSchema(facade);
        if (!schema.ok) {
            // Only reachable when the agent schema has not been created. A
            // table created later comes with the unique index already, so
            // there is nothing left for this migration to do.
            console.log(`[Migration] ${NAME}: agent schema incomplete `
                + `(${JSON.stringify(schema.row)}), nothing to merge`);
            return { groups: 0, removed: 0, agentsMoved: 0, dryRun, skipped: 'schema' };
        }

        if (dryRun) {
            const groups = groupRows(await facade.getAll(GROUPS_SQL));
            for (const g of groups) console.log(`[Migration] ${NAME} DRY-RUN would merge: ${describe(g)}`);
            const removed = groups.reduce((n, g) => n + g.dropIds.length, 0);
            const agentsMoved = groups.reduce((n, g) => n + g.agentCount, 0);
            console.log(`[Migration] ${NAME} DRY-RUN: ${groups.length} duplicate group(s), `
                + `${removed} row(s) to remove, ${agentsMoved} agent(s) to re-point; nothing written`);
            return { groups: groups.length, removed, agentsMoved, dryRun };
        }

        const result = await facade.withTransaction(async (client) => {
            // Same bounded wait as runDdl: behind a busy table, fail with 55P03
            // (and retry next boot) rather than hang the boot.
            await client.query(`SET LOCAL lock_timeout = '15s'`);
            // SHARE ROW EXCLUSIVE blocks every INSERT/UPDATE/DELETE on the
            // table until COMMIT but not reads, and it conflicts with itself,
            // so two replicas booting together run this one after the other.
            // The second then finds no groups.
            await client.query('LOCK TABLE agent_categories IN SHARE ROW EXCLUSIVE MODE');

            const { rows } = await client.query(GROUPS_SQL);
            const groups = groupRows(rows || []);
            let removed = 0;
            let agentsMoved = 0;
            for (const g of groups) {
                console.log(`[Migration] ${NAME} merging: ${describe(g)}`);
                for (const dropId of g.dropIds) {
                    const moved = await client.query(REASSIGN_SQL, [dropId, g.keepId]);
                    agentsMoved += moved?.rowCount || 0;
                    const del = await client.query('DELETE FROM agent_categories WHERE id = $1', [dropId]);
                    removed += del?.rowCount || 0;
                }
            }

            await client.query(INDEX_SQL);
            return { groups: groups.length, removed, agentsMoved, dryRun };
        });

        console.log(`[Migration] ${NAME} applied: merged ${result.groups} duplicate group(s), `
            + `removed ${result.removed} row(s), re-pointed ${result.agentsMoved} agent(s); `
            + 'idx_agent_categories_org_lname in place');
        return result;
    } catch (e) {
        console.error(`[Migration] ${NAME} failed (rolled back, retries next boot):`, e.message);
        throw e;
    }
}

module.exports = { up, INDEX_SQL, REASSIGN_SQL };

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run');
    up({ dryRun }).then(() => process.exit(0)).catch(() => process.exit(1));
}
