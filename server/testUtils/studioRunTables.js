// @typecheck strict
/**
 * The DDL of the App Studio run tables exactly as stores/studioAppData/schema.js ships it, for a
 * store test on PGlite (studio_app_action_runs, studio_app_action_run_steps, studio_app_triggers,
 * studio_app_record_events). Read from the file so
 * a test can never run against a copy that drifted from production.
 *
 *   await pg.exec(studioRunTableDdl('studio_app_action_runs'));
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** @param {'studio_app_action_runs' | 'studio_app_action_run_steps' | 'studio_app_triggers' | 'studio_app_record_events'} table */
function studioRunTableDdl(table) {
    // The outbox of record triggers has its DDL in a file of its own, next to schema.js.
    const file = table === 'studio_app_record_events' ? 'recordEventsSchema.js' : 'schema.js';
    const text = fs.readFileSync(path.join(__dirname, '..', 'stores', 'studioAppData', file), 'utf8');
    const m = new RegExp(`\`(\\s*CREATE TABLE IF NOT EXISTS ${table} [\\s\\S]*?)\``).exec(text);
    if (!m) throw new Error(`schema.js no longer creates ${table}`);
    return m[1];
}

module.exports = { studioRunTableDdl };
