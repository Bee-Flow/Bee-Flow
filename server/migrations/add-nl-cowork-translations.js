#!/usr/bin/env node
/**
 * One-time migration: Dutch for the Cowork sidebar entry (2026-08).
 *
 * Supersedes add-nl-work-mode-translations, which seeded `sidebar.work` as
 * "Werk" and `studio.tab.cowork` as "Cowork". Both keys are gone: the Studio
 * tab was folded into the standalone /app/cowork page, and the sidebar entry
 * is now `sidebar.cowork`.
 *
 * "Cowork" stays untranslated in every language — it is the product name of
 * the surface, like Studio. That was already the call for the Studio tab; the
 * sidebar disagreeing with it ("Werk") is precisely how one feature ended up
 * being called three things. "Samenwerken" would read as a feature for people
 * working with each other rather than work that Bee Flow performs itself.
 *
 * Also removes the two dead keys, so a workspace that had them translated does
 * not keep serving stale entries from its i18n_gui_nl config.
 *
 * Idempotent: the insert only fills a missing key, and the deletes are no-ops
 * once the keys are gone. Auto-runs from server boot (server/index.js).
 * Manual usage:
 *   node server/migrations/add-nl-cowork-translations.js
 */

const NL_TRANSLATIONS = {
    'sidebar.cowork': 'Cowork',
};

// Retired by the Cowork consolidation — see the header.
const RETIRED_KEYS = ['sidebar.work', 'studio.tab.cowork'];

async function up() {
    const languageStore = require('../stores/languageStore');
    // Eén atomaire bewerking (advisory lock over replica's heen): toevoegen én
    // pensioneren samen, zodat geen tussenstand zichtbaar wordt.
    let added = 0;
    let removed = 0;
    await languageStore.mutateGUITranslations('nl', (merged) => {
        added = 0; removed = 0; // de mutator kan opnieuw draaien — tel per poging
        for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
            if (!merged[key]) {
                merged[key] = value;
                added++;
            }
        }
        for (const key of RETIRED_KEYS) {
            if (key in merged) {
                delete merged[key];
                removed++;
            }
        }
        return merged;
    });
    if (added > 0 || removed > 0) {
        console.log(`[Migration] add-nl-cowork-translations applied (+${added} keys, -${removed} retired)`);
    }
}

module.exports = { up, NL_TRANSLATIONS, RETIRED_KEYS };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
