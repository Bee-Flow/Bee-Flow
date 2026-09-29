/**
 * Migration: Add pii_summary column to automation_run_steps (2026-08).
 *
 * Compact per-step PII metadata for the builder canvas's "colour lines by
 * PII" mode: `{ categories: {Email: 3, …}, groups: {Contact: 3, …},
 * source: 'guard'|'scan', degraded?: true }` — aggregate COUNTS only, never
 * the detected values.
 *
 * Deliberately its own column rather than a key inside output_json:
 * output_json is (a) replaced wholesale by the 256 KB truncation sentinel,
 * which would take the summary with it, and (b) the user-bindable
 * `steps.<id>.output.*` namespace, which must stay clean.
 *
 * Nullable, no backfill, no index — it is only ever read alongside the rest
 * of a run's step rows.
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_run_steps ADD COLUMN IF NOT EXISTS pii_summary JSONB`);
    console.log('[Migration] automation-pii-summary-2026-08 applied');
}

module.exports = { up };
