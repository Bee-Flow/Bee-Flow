/**
 * Migration: structured skill fields (Bee Flow Builder redesign, Sep 2026, S1).
 *
 * The Skills Studio edits STRUCTURE (ordered steps with references, rules
 * with a must/never polarity, worked examples with a good and a bad answer)
 * where the skill used to be three free-text columns. This migration:
 *
 *   1. adds the columns the store also adds lazily (`ADD COLUMN IF NOT
 *      EXISTS`, so either side may go first on a 2-replica rolling deploy):
 *      steps, rules_v2, examples_v2, version, knowledge_base_ids,
 *      allowed_automation_ids, last_used_at, output_schema;
 *   2. parses every skill whose structure is still NULL — `workflow` → steps
 *      (numbered lines), `rules` → rules_v2 (sentences; `never` on
 *      niet/geen/nooit/never/don't), `examples` → examples_v2 (the
 *      `Input:/Output:` pattern) — and writes the structure NEXT TO the
 *      original text. The text columns are never touched: the runtime still
 *      reads them, and a migrated skill renders byte-identically in the
 *      prompt (core/tools/skillInjection.test.js).
 *
 * Idempotent: only rows with a NULL facet are selected, and each UPDATE
 * writes only the facets that were NULL (`COALESCE(col, $n)`), so a row a
 * person has meanwhile edited in the Studio is never overwritten. Empty
 * text parses to `[]`, which is NOT NULL, so an empty skill is visited once.
 *
 * `--dry-run` (CLI) / `up({ dryRun: true })` logs what would be written per
 * row and writes nothing — not even the columns.
 *
 * Registered from stores/skillStore.js initDB (the house pattern of
 * automationStore/core.js): the migration runs after the store's DDL, on
 * every boot, and is a no-op once applied. Do not also list it in
 * boot/bootMigrations.js — de registratietest daar kent hem als store-bedraad.
 */

'use strict';

const { exec, getAll, run } = require('../db');
const {
    parseWorkflowToSteps,
    parseRulesToRulesV2,
    parseExamplesToExamplesV2,
} = require('../core/skills/skillStructure');

const TAG = '[Migration] skills-structured-fields';

const COLUMNS_SQL = `
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS steps JSONB DEFAULT NULL;
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS rules_v2 JSONB DEFAULT NULL;
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS examples_v2 JSONB DEFAULT NULL;
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS knowledge_base_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS allowed_automation_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE skills ADD COLUMN IF NOT EXISTS output_schema JSONB DEFAULT NULL;
`;

/** Parse one row's text facets. Pure; exported for the test. */
function planRow(row) {
    const plan = {};
    if (row.steps === null || row.steps === undefined) plan.steps = parseWorkflowToSteps(row.workflow || '');
    if (row.rules_v2 === null || row.rules_v2 === undefined) plan.rules_v2 = parseRulesToRulesV2(row.rules || '');
    if (row.examples_v2 === null || row.examples_v2 === undefined) plan.examples_v2 = parseExamplesToExamplesV2(row.examples || '');
    return plan;
}

/**
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ scanned: number, updated: number, dryRun: boolean }>}
 */
async function up(opts = {}) {
    const dryRun = opts.dryRun === true;
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);

    if (!dryRun) await exec(COLUMNS_SQL);

    let rows;
    try {
        rows = await getAll(
            `SELECT id, name, workflow, rules, examples, steps, rules_v2, examples_v2
               FROM skills
              WHERE steps IS NULL OR rules_v2 IS NULL OR examples_v2 IS NULL
              ORDER BY created_at ASC`,
        );
    } catch (err) {
        // Dry run on a database that does not have the columns yet: nothing to
        // plan against, and we must not create them.
        if (dryRun && /column .* does not exist/i.test(err.message)) {
            log(`${TAG} (dry run): structured columns do not exist yet — the real run would add them and parse every skill`);
            return { scanned: 0, updated: 0, dryRun };
        }
        throw err;
    }

    let updated = 0;
    for (const row of rows || []) {
        const plan = planRow(row);
        const facets = Object.keys(plan);
        if (facets.length === 0) continue;
        const summary = facets.map(f => `${f}=${plan[f].length}`).join(' ');
        if (dryRun) {
            log(`${TAG} (dry run): would parse skill ${row.id} "${row.name}" → ${summary}`);
            continue;
        }
        // COALESCE: a facet that gained structure between the SELECT and this
        // UPDATE (someone saved in the Studio) keeps what the person wrote.
        await run(
            `UPDATE skills
                SET steps = COALESCE(steps, $2::jsonb),
                    rules_v2 = COALESCE(rules_v2, $3::jsonb),
                    examples_v2 = COALESCE(examples_v2, $4::jsonb)
              WHERE id = $1`,
            [
                row.id,
                JSON.stringify(plan.steps ?? row.steps ?? []),
                JSON.stringify(plan.rules_v2 ?? row.rules_v2 ?? []),
                JSON.stringify(plan.examples_v2 ?? row.examples_v2 ?? []),
            ],
        );
        updated++;
        log(`${TAG}: parsed skill ${row.id} "${row.name}" → ${summary}`);
    }
    const scanned = (rows || []).length;
    if (dryRun) log(`${TAG} (dry run): ${scanned} skill(s) would be parsed; nothing written`);
    else if (scanned > 0) log(`${TAG} applied (${updated} of ${scanned} skill(s) parsed)`);
    return { scanned, updated, dryRun };
}

module.exports = { up, planRow, COLUMNS_SQL };

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run');
    up({ dryRun }).then((r) => {
        console.log(`${TAG}: done`, r);
        process.exit(0);
    }).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
