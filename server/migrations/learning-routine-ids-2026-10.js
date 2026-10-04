#!/usr/bin/env node
/**
 * Data migration: Learning Center progress follows the lessons that were
 * renamed from "routine" to "automation" (2026-10).
 *
 * A person's progress lives in per-user config blobs keyed by lesson,
 * exercise, course and badge ids (`learning_progress_user_<id>`,
 * `learning_exercises_user_<id>`, `learning_certificate_user_<id>`, ...). The
 * curriculum renamed 21 ids (data/learning-routine-id-map.json, e.g.
 * `routine-extra-triggers` → `automation-extra-triggers`); a blob that still
 * names the old id would show a finished lesson as not started and lose a
 * badge. Every learning blob is walked: an object key or a string value that
 * is exactly an old id becomes the new one. Nothing else is touched.
 *
 * Through configStore, which handles encryption at rest. Idempotent: a second
 * run finds no old id. Auto-runs from server boot. Manual usage:
 *   node server/migrations/learning-routine-ids-2026-10.js
 */

const ID_MAP = require('./data/learning-routine-id-map.json');

const has = (k) => Object.prototype.hasOwnProperty.call(ID_MAP, k);

/** `value` with every old id replaced; `changed.n` counts the replacements. Pure. */
function renameIds(value, changed = { n: 0 }) {
    if (typeof value === 'string') {
        if (has(value)) { changed.n += 1; return ID_MAP[value]; }
        return value;
    }
    if (Array.isArray(value)) return value.map((v) => renameIds(v, changed));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const key = has(k) ? ID_MAP[k] : k;
            if (key !== k) changed.n += 1;
            // Both spellings present: the new one is newer progress, keep it.
            if (key !== k && Object.prototype.hasOwnProperty.call(value, key)) continue;
            out[key] = renameIds(v, changed);
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
        rows = await getAll(`SELECT key FROM config WHERE key LIKE 'learning\\_%' AND key LIKE '%\\_user\\_%'`);
    } catch (err) {
        if (err?.code === '42P01') return { blobs: 0, ids: 0 }; // no config table yet
        throw err;
    }
    let blobs = 0;
    let ids = 0;
    for (const { key } of rows) {
        // getConfig/setConfig, not mutateConfig: they decrypt and encrypt, and a
        // blob without an old id is not written at all.
        const current = await configStore.getConfig(key);
        if (current == null || typeof current !== 'object') continue;
        const changed = { n: 0 };
        const next = renameIds(current, changed);
        if (!changed.n) continue;
        await configStore.setConfig(key, next);
        blobs += 1;
        ids += changed.n;
    }
    if (blobs) console.log(`[Migration] learning-routine-ids-2026-10 applied (${ids} ids in ${blobs} blobs)`);
    return { blobs, ids };
}

module.exports = { up, renameIds, ID_MAP };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
