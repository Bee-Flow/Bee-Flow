/**
 * Migration: routine evolution proposals (2026-09).
 *
 * `automation_evolutions` — one row per proposed change to a routine's OWN
 * definition, made by the routine itself (a monthly "evolution" root that
 * reads its run history and metrics) and applied only after a human approved
 * it. The row carries the builder patch plan, the versions before and after,
 * the outcome baseline the canary is judged against, and the canary verdict —
 * so "why does my routine look different" always has an answer, and a
 * regression can be rolled back to the exact version it replaced.
 *
 * Status lifecycle: proposed → applied (a new automation_versions row exists)
 * → canary (the next N live runs are watched) → kept | rolled_back. A plan
 * that fails validation or a builder call ends in `failed`; a proposal the
 * owner declines is `rejected`.
 *
 * Idempotent — CREATE TABLE / CREATE INDEX IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_evolutions (
            id              TEXT PRIMARY KEY,
            automation_id   TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            user_id         TEXT NOT NULL,
            status          TEXT NOT NULL DEFAULT 'proposed',
            rationale       TEXT,
            expected_effect TEXT,
            risk            TEXT,
            plan            JSONB NOT NULL DEFAULT '[]'::jsonb,
            version_before  INTEGER,
            version_after   INTEGER,
            baseline        JSONB,
            canary          JSONB,
            canary_runs     INTEGER NOT NULL DEFAULT 20,
            error           TEXT,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            applied_at      TIMESTAMPTZ,
            evaluated_at    TIMESTAMPTZ,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_evolutions_aid ON automation_evolutions(automation_id, created_at DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_evolutions_canary ON automation_evolutions(status) WHERE status = 'canary'`);
}

module.exports = { up };
