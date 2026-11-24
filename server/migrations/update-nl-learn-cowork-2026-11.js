#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the Cowork course after the Cowork redesign (Nov 2026). The four lessons of "Cowork: Delegate Your
 * Work", the Cowork parts of the capstone and of the automations lesson, and the course text now teach the screens
 * as they are: a task, one sentence, the card with What / When / Uses / Sends to, "Set up and test", the approval of
 * what the test produced, the task page with its Settings rows, and failures as cards under "Needs you". The old
 * Dutch taught the chips, Run / Schedule, Edit and the figure cards.
 *
 * The data is data/learn-cowork-2026-11-nl.json: `{ "reworded": { "<key>": { "nl": "<new Dutch>", "was": [...] } } }`.
 * `was` is every Dutch an install may hold for the key: what add-nl-learn-content-2026-10-translations seeded, and
 * for two keys what an earlier rewording wrote (update-nl-admin-dashboard-2026-11 for the reconnect quiz's
 * explanation, update-nl-settings-nav-2026-10 for the agent lesson's failure slide); those two entries moved here,
 * so one catalogue rewords each key. Keys the lessons added are seeded by add-nl-learn-content-2026-10-translations
 * (fill-missing), whose data file also ships the new Dutch for a fresh install.
 *
 * NL_REWORDED: replaced only while a workspace still has old shipped Dutch (`was`), or has no Dutch for the key, so
 * an admin's own wording stays. Idempotent. Auto-runs from server boot (boot/bootMigrations.js). Manual:
 *   node server/migrations/update-nl-learn-cowork-2026-11.js
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, 'data', 'learn-cowork-2026-11-nl.json');

/**
 * sha256 of data/learn-cowork-2026-11-nl.json. The boot ledger re-runs a migration when THIS FILE's checksum changes
 * and knows nothing about the data file; pinning the data's hash here makes every data change a change to this file.
 * The test fails until it is updated.
 */
const DATA_SHA256 = 'd2d6c4022f69d27ee1ebc09289255f37dea07e38075004e4875651058f39b471';

/** @returns {string} hex sha256 of the data file */
function dataHash() {
    return crypto.createHash('sha256').update(fs.readFileSync(DATA_FILE)).digest('hex');
}

/** @returns {Readonly<Record<string, { readonly was: readonly string[], readonly now: string }>>} */
function loadReworded() {
    /** @type {{ reworded: Record<string, { nl: string, was: string[] }> }} */
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    /** @type {Record<string, { readonly was: readonly string[], readonly now: string }>} */
    const table = {};
    for (const [key, { nl, was }] of Object.entries(data.reworded)) table[key] = Object.freeze({ was: Object.freeze([...was]), now: nl });
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
        // Missing -> write the current text; still old shipped text -> replace; anything else is the workspace's own.
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
        console.log(`[Migration] update-nl-learn-cowork-2026-11 applied (${reworded} reworded)`);
    }
    return { reworded };
}

module.exports = { up, applyNl, NL_REWORDED, DATA_SHA256, dataHash };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
