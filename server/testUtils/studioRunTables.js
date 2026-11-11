// @typecheck strict
/**
 * The DDL of the App Studio run tables exactly as stores/studioAppData/schema.js ships it, for a
 * store test on PGlite (studio_app_action_runs, studio_app_action_run_steps, studio_app_triggers,
 * studio_app_record_events, the webhook endpoints and deliveries). Read from the file so
 * a test can never run against a copy that drifted from production.
 *
 *   await pg.exec(studioRunTableDdl('studio_app_action_runs'));
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Tables whose DDL is in a file of its own, next to schema.js. */
/** @type {Record<string, string>} */
const OWN_FILE = {
    studio_app_record_events: 'recordEventsSchema.js',
    studio_app_webhook_endpoints: 'webhookTriggersSchema.js',
    studio_app_webhook_deliveries: 'webhookTriggersSchema.js',
};

/** @param {'studio_app_action_runs' | 'studio_app_action_run_steps' | 'studio_app_triggers' | 'studio_app_record_events' | 'studio_app_webhook_endpoints' | 'studio_app_webhook_deliveries'} table */
function studioRunTableDdl(table) {
    const file = Object.hasOwn(OWN_FILE, table) ? OWN_FILE[table] : 'schema.js';
    const text = fs.readFileSync(path.join(__dirname, '..', 'stores', 'studioAppData', file), 'utf8');
    const m = new RegExp(`\`(\\s*CREATE TABLE IF NOT EXISTS ${table} [\\s\\S]*?)\``).exec(text);
    if (!m) throw new Error(`schema.js no longer creates ${table}`);
    return m[1];
}

module.exports = { studioRunTableDdl };
