#!/usr/bin/env node
/**
 * One-time migration: Dutch for the two invite-redeem failure banners on the
 * login screen (`?error=invite_expired` / `?error=invite_error`, set by
 * /auth/redeem-invite/:token). Before these keys existed the visitor just
 * landed on a bare login page with no clue their invitation link did
 * anything at all.
 *
 * Idempotent: only fills keys that are missing, so a workspace that already
 * curated its own wording keeps it. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-invite-redeem-translations.js
 */

const NL_TRANSLATIONS = {
    'login.invite_link_expired': 'Deze uitnodigingslink is verlopen of niet meer geldig. Vraag degene die je heeft uitgenodigd om een nieuwe.',
    'login.invite_link_error': 'Er ging iets mis bij het openen van deze uitnodiging. Probeer de link opnieuw of vraag om een nieuwe.',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-invite-redeem-translations: added ${added} NL keys`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(({ added }) => {
        console.log(`Done (${added} added).`);
        process.exit(0);
    }).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
