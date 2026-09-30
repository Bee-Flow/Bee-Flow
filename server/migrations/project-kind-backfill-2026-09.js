/**
 * Migration: classify the projects that existed before the workspace /
 * Solution split.
 *
 * `projects.kind` (stores/projectStore.js) tells a collaborative project
 * ('workspace', the Projects page) from a Studio Solution ('solution'). Rows
 * created before the split have NULL, which lists them in BOTH places until
 * their owner picks one (PUT /api/projects/:id/kind). This migration picks for
 * the owner only where the data leaves no doubt, and leaves everything else
 * NULL: a wrong guess hides a project from the screen its owner uses, while a
 * NULL merely shows it twice.
 *
 * Solution evidence, any one of:
 *   - it was installed from a Blueprint (`installed_from_blueprint_id`);
 *   - it has a published release (`project_releases`) or a gallery row made
 *     from it (`project_blueprints.source_project_id`);
 *   - automations, apps, webpages or tables are filed in it — kinds only a
 *     Solution holds;
 *   - its icon is the Studio's '📦' AND no conversation is filed in it (the
 *     icon alone is a weak signal, so any chat overrules it).
 * Workspace evidence: conversations (direct or agent), notebooks or project
 * memories filed in it.
 *
 * A row becomes a Solution only with Solution evidence and NO workspace
 * evidence, and a workspace only the other way round. A row with both stays
 * NULL. Before the split one project served both screens (a chat tab next to
 * a content tab that filed routines and tables), so a project with thirty
 * filed chats and one routine is ordinary, not a Solution: calling it one
 * would take it off the Projects page and strip its chats of the project's
 * instructions, knowledge and memories. NULL lists it on both sides until its
 * owner decides.
 *
 * Every kind this migration sets is marked `kind_guessed`: the owner may
 * correct the guess once (PUT /api/projects/:id/kind), as long as the project
 * holds nothing the other side refuses.
 *
 * Only rows whose kind is still NULL are touched, in the UPDATE itself: an
 * owner who classified a project (even while this runs, Postgres re-checks the
 * predicate on the row it locks) keeps the answer they gave, and a second run
 * changes nothing. `updated_at` and `version` are left alone, so no list is
 * reordered and no open settings form gets a conflict.
 *
 * The evidence tables belong to other stores and may be absent on a light
 * build, or predate their `project_id` column; each one is used only when its
 * column exists (pg_attribute over to_regclass). Both UPDATEs run in one
 * transaction, and a failure is rethrown so the migration ledger does not
 * record it and the next boot retries.
 *
 * Registered in boot/bootMigrations.js LOOSE_MIGRATIONS.
 *
 * Standalone: node migrations/project-kind-backfill-2026-09.js [--dry-run]
 */

'use strict';

const NAME = 'project-kind-backfill-2026-09';

// Tables whose `project_id` column names the project a row is filed in.
const SOLUTION_MEMBERS = ['automations', 'studio_apps', 'webpages', 'datatables'];
const CONVERSATIONS = ['direct_conversations', 'agent_conversations'];
const WORKSPACE_MEMBERS = [...CONVERSATIONS, 'notebooks', 'user_memories'];

// The Studio's "New Solution" form gave every Solution this icon.
const SOLUTION_ICON = '📦';

async function hasColumn(db, table, column) {
    const row = await db.getOne(
        `SELECT EXISTS (
            SELECT 1 FROM pg_attribute
             WHERE attrelid = to_regclass($1::text)
               AND attname = $2 AND NOT attisdropped
         ) AS ok`,
        [table, column],
    );
    return !!row?.ok;
}

/** `EXISTS (…)` for every table that has the column; the table names are constants above. */
async function filedIn(db, tables, column = 'project_id') {
    const out = [];
    for (const table of tables) {
        if (await hasColumn(db, table, column)) {
            out.push(`EXISTS (SELECT 1 FROM ${table} x WHERE x.${column} = p.id)`);
        }
    }
    return out;
}

const anyOf = (clauses) => (clauses.length ? `(${clauses.join(' OR ')})` : 'FALSE');

/**
 * The two predicates over `projects p`, built from the tables this database
 * has. Each side needs its own evidence AND the absence of the other's, so
 * conflicting evidence classifies nothing.
 * @returns {Promise<{ solution: string, workspace: string, params: string[] }>}
 */
async function buildPredicates(db) {
    const strong = [];
    if (await hasColumn(db, 'projects', 'installed_from_blueprint_id')) {
        strong.push('p.installed_from_blueprint_id IS NOT NULL');
    }
    strong.push(...await filedIn(db, ['project_releases']));
    strong.push(...await filedIn(db, ['project_blueprints'], 'source_project_id'));
    strong.push(...await filedIn(db, SOLUTION_MEMBERS));

    const conversations = await filedIn(db, CONVERSATIONS);
    const boxed = `(p.icon = $1 AND NOT ${anyOf(conversations)})`;

    const solutionEvidence = anyOf([...strong, boxed]);
    const workspaceEvidence = anyOf(await filedIn(db, WORKSPACE_MEMBERS));
    return {
        solution: `(${solutionEvidence} AND NOT ${workspaceEvidence})`,
        workspace: `(${workspaceEvidence} AND NOT ${solutionEvidence})`,
        params: [SOLUTION_ICON],
    };
}

/**
 * @param {{ dryRun?: boolean, db?: object, initSchema?: () => Promise<unknown> }} [opts]
 *        `db` (getOne + withTransaction, db.js's shape) and `initSchema` are
 *        seams for the integration test; boot calls up() without arguments.
 * @returns {Promise<{ solution: number, workspace: number, unclassified: number, dryRun: boolean }>}
 */
async function up({ dryRun = false, db = null, initSchema = null } = {}) {
    try {
        const facade = db || require('../db');

        // The `kind` column is the project store's; boot runs this ladder next
        // to the store inits, so wait for it (memoised: the same promise).
        await (initSchema || require('../stores/projectStore').initDB)();

        if (!(await hasColumn(facade, 'projects', 'kind'))) {
            // The store init above creates it; its absence means that init
            // did not complete. Throw, so the ledger does not record a run
            // that classified nothing.
            throw new Error('projects.kind does not exist yet');
        }

        const { solution, workspace, params } = await buildPredicates(facade);
        // Mark the guess, so its owner may correct it once. The store init
        // above adds the column; a schema without it still classifies.
        const guessed = (await hasColumn(facade, 'projects', 'kind_guessed')) ? ', kind_guessed = TRUE' : '';

        if (dryRun) {
            const row = await facade.getOne(
                `SELECT COUNT(*) FILTER (WHERE ${solution})::int AS solution,
                        COUNT(*) FILTER (WHERE ${workspace})::int AS workspace,
                        COUNT(*)::int AS pending
                   FROM projects p
                  WHERE p.kind IS NULL`,
                params,
            );
            const result = {
                solution: row?.solution || 0,
                workspace: row?.workspace || 0,
                unclassified: (row?.pending || 0) - (row?.solution || 0) - (row?.workspace || 0),
                dryRun: true,
            };
            console.log(`[Migration] ${NAME} DRY-RUN: would classify ${result.solution} Solution(s) and `
                + `${result.workspace} project(s); ${result.unclassified} stay unclassified; nothing written`);
            return result;
        }

        const result = await facade.withTransaction(async (client) => {
            // Behind a busy table, fail (and retry next boot) rather than hang it.
            await client.query(`SET LOCAL lock_timeout = '15s'`);
            const asSolution = await client.query(
                `UPDATE projects p SET kind = 'solution'${guessed} WHERE p.kind IS NULL AND ${solution}`,
                params,
            );
            const asWorkspace = await client.query(
                `UPDATE projects p SET kind = 'workspace'${guessed} WHERE p.kind IS NULL AND ${workspace}`,
                params,
            );
            const left = await client.query('SELECT COUNT(*)::int AS n FROM projects WHERE kind IS NULL');
            return {
                solution: asSolution?.rowCount || 0,
                workspace: asWorkspace?.rowCount || 0,
                unclassified: Number(left?.rows?.[0]?.n) || 0,
                dryRun: false,
            };
        });

        console.log(`[Migration] ${NAME} applied: ${result.solution} Solution(s), ${result.workspace} project(s); `
            + `${result.unclassified} left for their owners to classify`);
        return result;
    } catch (e) {
        console.error(`[Migration] ${NAME} failed (rolled back, retries next boot):`, e.message);
        throw e;
    }
}

module.exports = { up, SOLUTION_ICON };

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run');
    up({ dryRun }).then(() => process.exit(0)).catch(() => process.exit(1));
}
