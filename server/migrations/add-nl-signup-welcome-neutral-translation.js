#!/usr/bin/env node
/**
 * Migration: Dutch translation for the account-type-agnostic signup welcome
 * line (BFSF-276).
 *
 * Step 1 of the signup wizard used to render `signup.wizard_welcome_org`
 * ("Laten we je organisatie … instellen") unconditionally, because the
 * org-vs-personal choice is only made on step 2. Step 1 now renders the new
 * `signup.wizard_welcome_neutral` key until the user has actually picked, so
 * that key needs a NL value or Dutch users drop to the English default.
 *
 * Idempotent — only inserts keys that don't already have a NL value, safe to
 * re-run. Auto-runs from server boot (server/index.js). Manual usage:
 *   node server/migrations/add-nl-signup-welcome-neutral-translation.js
 */

const NL_TRANSLATIONS = {
    'signup.wizard_welcome_neutral': 'Laten we je account in een paar snelle stappen instellen op Bee Flow.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-signup-welcome-neutral-translation applied (+${added} keys)`);
    }
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
