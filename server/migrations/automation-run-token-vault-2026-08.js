/**
 * Migration: Add pii_token_map to automation_runs (2026-08).
 *
 * The run-scoped token vault. Routines used to mint a fresh token namespace per
 * STEP, so `[person_1]` in step 2 and `[person_1]` in step 5 could be two
 * different people — and a token minted on a tool OUTPUT had no map at all, so
 * it travelled downstream as an unrestorable literal into emails and documents.
 * One map per run fixes both: every mint is seeded from it, so a value keeps the
 * same placeholder everywhere, and nothing tokenized is ever unrestorable.
 *
 * Same contract as `agent_conversations.pii_token_map` /
 * `direct_conversations.pii_token_map` / `notebooks.pii_token_map`: plaintext
 * JSONB, because restoring is the whole point. It lives no longer than the run
 * row itself (jobs/runRetention.js, 90 days by default, FK-cascade on delete).
 *
 * Deliberately NOT surfaced by rowToRun(): run rows are serialized straight to
 * the client, and the map holds real personal data. Only the runner reads it,
 * via getRunTokenMap().
 *
 * Nullable, no backfill, no index — read once per run by primary key.
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS pii_token_map JSONB`);
    console.log('[Migration] automation-run-token-vault-2026-08 applied');
}

module.exports = { up };
