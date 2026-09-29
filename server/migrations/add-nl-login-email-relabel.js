#!/usr/bin/env node
/**
 * Migration: Dutch translations for the relabelled login identifier field.
 *
 * The login field used the `login.username` key ("Gebruikersnaam"), which
 * misled users into typing their display name — but the backend only accepts
 * the registered email address, so they hit "Invalid credentials" (BFSF-235/
 * 236/237/238). The field now uses the honest `login.email` / `login.enter_email`
 * keys; this migration supplies their Dutch values so NL users see "E-mailadres"
 * instead of falling back to the English default.
 *
 * Idempotent — only inserts keys that don't already have a NL value, safe to
 * re-run. Auto-runs from server boot (server/index.js). Manual usage:
 *   node server/migrations/add-nl-login-email-relabel.js
 */

const NL_TRANSLATIONS = {
    'login.email': 'E-mailadres',
    'login.enter_email': 'jouwnaam@voorbeeld.nl',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-login-email-relabel applied (+${added} keys)`);
    }
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
