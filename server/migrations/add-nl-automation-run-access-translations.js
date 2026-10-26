#!/usr/bin/env node
// @typecheck
/**
 * Dutch for the hint a viewer sees where "Run now" / "Run again" would be
 * (automations.run.*): the share role "view" reads an automation but does not
 * start it.
 *
 * Idempotent: only fills keys that are missing. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-automation-run-access-translations.js
 */

const NL_TRANSLATIONS = Object.freeze({
    'automations.run.viewOnlyHint': 'Je kunt deze automatisering bekijken maar niet starten. Vraag de eigenaar om toegang om te starten.',
});

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
    await languageStore.mutateGUITranslations('nl', (current) => {
        const result = applyNl(current);
        added = result.added;
        return result.merged;
    });
    if (added > 0) {
        console.log(`[Migration] add-nl-automation-run-access-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, applyNl, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
