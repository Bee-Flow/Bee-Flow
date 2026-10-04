#!/usr/bin/env node
/**
 * One-time migration: Dutch for the Solutions overview strings that arrived
 * after add-nl-solution-overview-translations had already run (the schema
 * ledger never runs a catalogue twice, so new keys need their own file): the
 * search and filter bar, the empty and loading states, and the two counted
 * kinds that joined a Solution (skills and document templates).
 *
 * Usage:  node server/migrations/add-nl-solution-overview-2-translations.js
 *
 * Same split as its siblings: descriptive copy is translated, product nouns
 * ('Solution', 'Blueprint', 'skill') stay English.
 */

const NL_TRANSLATIONS = {
    // ── Zoeken en filteren ─────────────────────────────────────
    'solutions.search_placeholder': 'Solutions zoeken',
    'solutions.filter_label': 'Solutions filteren',
    'solutions.filter_all': 'Alle',
    'solutions.filter_mine': 'Van mij',
    'solutions.filter_attention': 'Vraagt aandacht',
    'solutions.filter_no_match': 'Geen Solution past bij deze zoekopdracht of dit filter.',

    // ── Lege en ladende toestand ───────────────────────────────
    'solutions.empty_title': 'Breng de onderdelen samen',
    'solutions.empty_create': 'Eerste Solution maken',
    'solutions.empty_install': 'Een Blueprint installeren',
    'solutions.loading': 'Solutions laden',
    'solutions.overview_retry': 'Opnieuw proberen',

    // ── Tel-familie: de twee nieuwe soorten ────────────────────
    'solutions.install_count_skills': '{count} skill',
    'solutions.install_count_skills_plural': '{count} skills',
    'solutions.install_count_document_templates': '{count} sjabloon',
    'solutions.install_count_document_templates_plural': '{count} sjablonen',
};

/**
 * `up()` NEVER exits the process — process.exit() stays inside the require.main
 * branch below.
 *
 * Idempotent: only keys with no Dutch value yet are filled, so re-running it
 * cannot overwrite a translation somebody has since corrected by hand.
 */
async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-solution-overview-2-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then((r) => {
        console.log(r.added === 0
            ? 'All translations already exist. Nothing to do.'
            : `✓ Done! Added ${r.added} translations.`);
        process.exit(0);
    }).catch(err => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
}
