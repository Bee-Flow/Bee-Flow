// @typecheck strict
'use strict';
/**
 * Migration: two columns on `skills` (2026-11).
 *
 *   agent_only BOOLEAN NOT NULL DEFAULT false
 *       "Only through agents": the skill is ignored as a session skill in a
 *       direct chat (core/skills/agentOnlySkills.mts). false = usable
 *       everywhere, which is what every existing skill keeps.
 *   category TEXT DEFAULT NULL
 *       The owner's free-text label (stores/skill/rows.js cleanCategory);
 *       NULL = no category.
 *
 * The store's own schema (stores/skill/schema.js) carries the same two
 * statements, so either side may run first on a rolling deploy. A database
 * without a `skills` table yet is skipped: the store creates the table with
 * the columns on its first init.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS.
 */

const STATEMENTS = [
    'ALTER TABLE skills ADD COLUMN IF NOT EXISTS agent_only BOOLEAN NOT NULL DEFAULT false',
    'ALTER TABLE skills ADD COLUMN IF NOT EXISTS category TEXT DEFAULT NULL',
];

/** @param {{ exec: (sql: string) => Promise<unknown> }} [db] */
async function up(db = require('../db')) {
    await db.exec(`DO $$ BEGIN
        IF to_regclass('public.skills') IS NOT NULL THEN
            ${STATEMENTS.map((s) => `EXECUTE '${s.replace(/'/g, "''")}';`).join('\n            ')}
        END IF;
    END $$;`);
}

module.exports = { up, STATEMENTS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
