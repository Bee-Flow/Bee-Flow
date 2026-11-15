#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the admin dashboard round (Nov 2026, waves 0-3). The English of
 * the AI configuration screens became provider-neutral (no example vendor or
 * model names in hints and placeholders, "Claude models" for the Claude
 * section, the reranker chain described as a chain), the context lesson
 * computes its examples from the workspace's own models instead of naming two,
 * and the admin panels that moved into the dashboard rail got new labels.
 *
 * The data is one manifest per work package in data/admin-dashboard-2026-11/*.json:
 * `{ "reworded": { "<key>": { "nl": "<new Dutch>", "was": ["<old shipped Dutch>"] } } }`.
 * A new manifest needs no code here, only a new DATA_SHA256 (the test names it).
 *
 * NL_REWORDED: replaced only while a workspace still has the OLD shipped Dutch
 * (`was`), or has no Dutch for the key at all, so an admin's own wording stays.
 * Idempotent. Auto-runs from server boot (boot/bootMigrations.js). Manual:
 *   node server/migrations/update-nl-admin-dashboard-2026-11.js
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data', 'admin-dashboard-2026-11');

/**
 * sha256 over the manifests (sorted file names and their bytes). The boot ledger
 * re-runs a migration when THIS FILE's checksum changes and knows nothing about
 * the data files, so pinning their hash here makes every manifest change a change
 * to this file; the test fails until it is updated.
 */
const DATA_SHA256 = 'afff565485157ed46460ccb9eb8bffc67d7149237893c1a44f5d397b6fafa838';

/** @returns {string[]} the manifest file names, sorted */
function manifestFiles() {
    return fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort();
}

/** @returns {string} hex sha256 of every manifest, in name order */
function manifestHash() {
    const hash = crypto.createHash('sha256');
    for (const f of manifestFiles()) hash.update(`${f}\0`).update(fs.readFileSync(path.join(DATA_DIR, f))).update('\0');
    return hash.digest('hex');
}

/** @returns {Readonly<Record<string, { readonly was: readonly string[], readonly now: string }>>} */
function loadReworded() {
    /** @type {Record<string, { readonly was: readonly string[], readonly now: string }>} */
    const table = {};
    for (const f of manifestFiles()) {
        /** @type {{ reworded?: Record<string, { nl: string, was: string[] }> }} */
        const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        for (const [key, { nl, was }] of Object.entries(manifest.reworded || {})) {
            if (key in table) throw new Error(`update-nl-admin-dashboard-2026-11: ${key} is in two manifests (${f})`);
            table[key] = Object.freeze({ was: Object.freeze([...was]), now: nl });
        }
    }
    return Object.freeze(table);
}

const NL_REWORDED = loadReworded();

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
function applyNl(merged) {
    let reworded = 0;
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        // Missing -> write the current text; still the old shipped text ->
        // replace; anything else is the workspace's own wording and stays.
        if (!merged[key] || was.includes(merged[key])) {
            if (merged[key] !== now) reworded++;
            merged[key] = now;
        }
    }
    return { merged, reworded };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let reworded = 0;
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        reworded = result.reworded;
        return result.merged;
    });
    if (reworded > 0) {
        console.log(`[Migration] update-nl-admin-dashboard-2026-11 applied (${reworded} reworded)`);
    }
    return { reworded };
}

module.exports = { up, applyNl, NL_REWORDED, DATA_SHA256, manifestHash };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
