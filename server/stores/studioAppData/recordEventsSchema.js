// @typecheck strict
'use strict';

/**
 * The outbox of record triggers (queries in ./recordEvents.mts, the rules in
 * appStudio/triggers/recordTriggerRule.mts). One row per changed record and armed trigger,
 * written by the record write path only for a table that has an armed trigger. The row goes
 * with its app (ON DELETE CASCADE).
 *   table_id / event / row_id   which row changed and how (create, update, delete)
 *   row_before / row_after      the row as the owner reads it. Personal data at rest: dropped
 *                               the moment a delivery is skipped, and with the row after the
 *                               retention (jobs/studioAppTriggers.js through recordDrain.mts)
 *   writer_kind / writer_key    who wrote it as a kind (public, member, owner, trigger) and a
 *                               one-way key for the burst limit; never a name or an account id
 *   depth / cause_trigger_id    the chain of trigger runs the write came from (the loop guard)
 *   state                       pending, claimed (a compare-and-set: one instance starts the run),
 *                               fired (run_id is the run) or skipped (outcome_code says why)
 */
/** @param {(sql: string) => Promise<unknown>} exec  the schema's own exec (stores/studioAppData/schema.js) */
async function initRecordEvents(exec) {
    await exec(`
        CREATE TABLE IF NOT EXISTS studio_app_record_events (
            seq BIGSERIAL PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES studio_apps(id) ON DELETE CASCADE,
            trigger_id TEXT NOT NULL,
            table_id TEXT NOT NULL,
            event TEXT NOT NULL,
            row_id TEXT NOT NULL,
            row_before JSONB,
            row_after JSONB,
            writer_kind TEXT NOT NULL,
            writer_key TEXT,
            depth INTEGER NOT NULL DEFAULT 0,
            cause_trigger_id TEXT,
            state TEXT NOT NULL DEFAULT 'pending',
            outcome_code TEXT,
            run_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            claimed_at TIMESTAMPTZ,
            done_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_studio_app_record_events_pending ON studio_app_record_events(app_id, trigger_id, seq) WHERE state = 'pending';
        CREATE INDEX IF NOT EXISTS idx_studio_app_record_events_run ON studio_app_record_events(run_id) WHERE run_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_studio_app_record_events_done ON studio_app_record_events(done_at) WHERE state <> 'pending';
    `);
}

module.exports = { initRecordEvents };
