#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for linking a Nextcloud account to an existing Bee Flow account once,
 * after a normal sign-in: the action on the embedded sign-in screen, the card
 * in the security settings that completes the link, and the note that a
 * pairing code is shown once.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. Auto-runs from server boot (boot/bootMigrations.js).
 * Manual usage:
 *   node server/migrations/add-nl-nc-link-2026-11-translations.js
 */

const NL_TRANSLATIONS = Object.freeze({
    'app.nc_link_required_link': 'Aanmelden om te koppelen',
    'app.nc_link_required_hint': 'Bee Flow opent in een nieuw tabblad. Meld je daar aan en koppel je Nextcloud-account; kom daarna hier terug en probeer het opnieuw.',
    'mfa.nc_link_title': 'Koppel je Nextcloud-account',
    'mfa.nc_link_body': 'Koppel het Nextcloud-account {uid} op {host} aan dit Bee Flow-account. Bee Flow binnen Nextcloud meldt je daarna aan als dit account. Ga alleen verder als je deze pagina zelf hebt geopend vanuit Bee Flow in Nextcloud.',
    'mfa.nc_link_button': 'Nextcloud-account koppelen',
    'mfa.nc_link_done': 'Je Nextcloud-account is gekoppeld. Ga terug naar Nextcloud en laad Bee Flow opnieuw.',
    'mfa.nc_link_failed': 'Het Nextcloud-account kon niet worden gekoppeld. Open Bee Flow in Nextcloud opnieuw voor een nieuwe koppeling.',
    'mfa.nc_link_other_account': 'Deze koppeling is voor een ander Bee Flow-account. Meld je aan met het account waarvoor ze is gemaakt.',
    'integ.org_nc_pairing_shown_once': 'Eenmalig getoond, direct na het aanmaken',
});

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-nc-link-2026-11-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-nc-link-2026-11-translations failed:', e.message);
        process.exit(1);
    });
}
