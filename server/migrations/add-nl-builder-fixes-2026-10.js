#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the automation builder fixes of October 2026: the HTTP request
 * query parameters editor and cURL import (http_query.*), who can call an
 * automation as an agent tool (automationAgentBindings.*), the builder
 * assistant's question cards, plan cards, web search notices and tables
 * created on Apply (automations.assistant.*), the "not linked" hint in the
 * agent's tool list, and the Studio "no access" page.
 *
 * The Dutch itself is in data/builder-fixes-2026-10-nl.json.
 * SAME_AS_ENGLISH lists keys whose Dutch is the English word itself; they are
 * not seeded.
 *
 * Idempotent: only fills keys that are missing. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-builder-fixes-2026-10.js
 */

const path = require('node:path');

const DATA = require(path.join(__dirname, 'data', 'builder-fixes-2026-10-nl.json'));

/**
 * sha256 of data/builder-fixes-2026-10-nl.json. The boot ledger re-runs a
 * migration when THIS FILE's checksum changes and knows nothing about the data
 * file, so pinning the hash here makes every data change a change to this file.
 */
const DATA_SHA256 = 'fbfd1e3190c7423fc37dbfa7f5e5a904929463c4f0e08902a2095bd0fbf966c6';

const NL_TRANSLATIONS = Object.freeze({ ...DATA.translations });

/** Keys whose Dutch is the English text itself; deliberately not seeded. */
const SAME_AS_ENGLISH = Object.freeze([...DATA.sameAsEnglish]);

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
function applyNl(merged) {
    let added = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    return { merged, added };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let added = 0;
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-builder-fixes-2026-10 applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS, SAME_AS_ENGLISH, DATA_SHA256 };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
