#!/usr/bin/env node
/**
 * Data migration: product-website pages follow the demo that was renamed from
 * "routines" to "automations" (2026-10).
 *
 * A `feature-demo` block names the demo it embeds (`feature: 'routines'`), and
 * a page can link to it (`/demo/routines`). The demo id is now `automations`
 * (cmsDefaults DEMO_FEATURE_IDS, agent-hub/src/demo), so a stored page that
 * still says `routines` would carry a dead panel. Every CMS blob is walked:
 * pages, their locale overrides, the published snapshots and the templates.
 * A `feature` field that is exactly 'routines' becomes 'automations', and a
 * string that contains `/demo/routines` gets `/demo/automations`. Nothing
 * else is touched.
 *
 * Through configStore. Idempotent: a second run finds nothing to change.
 * Auto-runs from server boot. Manual usage:
 *   node server/migrations/cms-routine-demo-2026-10.js
 */

/** `value` with the demo renamed; `changed.n` counts the changes. Pure. */
function renameDemo(value, changed = { n: 0 }) {
    if (typeof value === 'string') {
        const next = value.replace(/\/demo\/routines(?![\w-])/g, '/demo/automations');
        if (next !== value) changed.n += 1;
        return next;
    }
    if (Array.isArray(value)) return value.map((v) => renameDemo(v, changed));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (k === 'feature' && v === 'routines') {
                out[k] = 'automations';
                changed.n += 1;
            } else {
                out[k] = renameDemo(v, changed);
            }
        }
        return out;
    }
    return value;
}

async function up() {
    const { getAll } = require('../db');
    const configStore = require('../stores/configStore');
    let rows = [];
    try {
        rows = await getAll(`SELECT key FROM config WHERE key LIKE 'cms\\_%'`);
    } catch (err) {
        if (err?.code === '42P01') return { blobs: 0, changes: 0 };
        throw err;
    }
    let blobs = 0;
    let changes = 0;
    for (const { key } of rows) {
        const current = await configStore.getConfig(key);
        if (current == null || typeof current !== 'object') continue;
        const changed = { n: 0 };
        const next = renameDemo(current, changed);
        if (!changed.n) continue;
        await configStore.setConfig(key, next);
        blobs += 1;
        changes += changed.n;
    }
    if (blobs) console.log(`[Migration] cms-routine-demo-2026-10 applied (${changes} changes in ${blobs} blobs)`);
    return { blobs, changes };
}

module.exports = { up, renameDemo };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
