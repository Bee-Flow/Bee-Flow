#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the Nextcloud trigger switch "also react to events of colleagues"
 * now that calendar events have it too (#407): the hint names calendar events
 * and calendars next to messages, cards, rows, forms and files.
 *
 * NL_REWORDED: replaced only while a workspace still has the OLD shipped
 * Dutch (`was`, from add-nl-nc-trigger-scope-2026-10-translations), so an
 * admin's own wording stays. That catalogue is an unchanged file, so the boot
 * ledger would not re-run it; the new Dutch reaches existing installs from
 * here. Idempotent. Auto-runs from server boot (boot/bootMigrations.js).
 * Manual: node server/migrations/update-nl-nc-trigger-scope-calendar-2026-10.js
 */

/** @type {Readonly<Record<string, { was: string[], now: string }>>} */
const NL_REWORDED = Object.freeze({
    'nc_trigger_scope.hint': {
        was: ['Uit: alleen wat je zelf doet start deze automatisering. Aan: ook een bericht, kaart, rij, formulierinzending of bestandswijziging van een collega start haar, maar alleen als het gaat om een gesprek, bord, tabel, formulier of bestand dat je zelf in Nextcloud kunt zien.'],
        now: 'Uit: alleen wat je zelf doet start deze automatisering. Aan: ook een bericht, kaart, rij, formulierinzending, bestandswijziging of agenda-afspraak van een collega start haar, maar alleen als het gaat om een gesprek, bord, tabel, formulier, bestand of agenda dat je zelf in Nextcloud kunt zien.',
    },
});

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
        console.log(`[Migration] update-nl-nc-trigger-scope-calendar-2026-10 applied (${reworded} reworded)`);
    }
    return { reworded };
}

module.exports = { up, applyNl, NL_REWORDED };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
