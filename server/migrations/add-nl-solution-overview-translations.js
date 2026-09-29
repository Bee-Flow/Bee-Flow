#!/usr/bin/env node
/**
 * One-time migration: Dutch translations for the Solutions overview (O3).
 *
 * Usage:  node server/migrations/add-nl-solution-overview-translations.js
 *
 * Merges into the existing i18n_gui_nl config without overwriting any
 * translation that already exists.
 *
 * Same split as its two siblings, and for the same reason: descriptive copy is
 * translated, product nouns stay English. 'Solution' and 'Blueprint' are
 * untouched, and so is 'run' — the runs table, the builder and the phone all
 * call it a run in Dutch already, and inventing a second word for one card
 * would make the same thing read as two.
 *
 * Half of these strings exist to say that something could NOT be read. They are
 * the ones worth translating carefully: an English "Not checked" on a Dutch
 * card is exactly the sentence a reader skips, and skipping it is how a
 * Solution nobody verified comes to look verified.
 */

const NL_TRANSLATIONS = {
    // ── De ontbrekende helft van de tel-familie ────────────────
    'solutions.install_count_notebooks': '{count} notitieboek',
    'solutions.install_count_notebooks_plural': '{count} notitieboeken',

    // ── Namen voor de gaten die /api/projects/summary meldt ────
    'solutions.section_notebooks': 'notitieboeken',
    'solutions.section_runs': 'hoe vaak er iets gedraaid heeft',
    'solutions.section_completeness': 'de controles',
    'solutions.section_update': 'of er een nieuwere versie is',
    'solutions.section_installed_versions': 'welke versie geïnstalleerd is',
    'solutions.section_blueprints': 'de Blueprints die hier bewaard zijn',

    // ── Het overzicht: tabs, meldingen, lege toestanden ────────
    // Deze stond er al in het Engels maar had nog geen Nederlands, en de
    // Catalogus-kaart is de eerste plek die hem toont.
    'solutions.blueprint_version': 'Blueprint v{version}',
    'solutions.tab_ours': 'Van ons',
    'solutions.tab_installed': 'Geïnstalleerd',
    'solutions.tab_catalogue': 'Catalogus',
    'solutions.overview_failed': 'Het overzicht kon niet geladen worden — dat is dus niet "je hebt geen Solutions". Probeer het zo nog eens.',
    'solutions.overview_partial': 'Niet alles kon gelezen worden: {sections}. Wat ontbreekt blijft leeg op de kaarten, in plaats van als niets te verschijnen.',
    'solutions.overview_more': 'Alleen de {count} laatst gewijzigde Solutions staan hier.',
    'solutions.installed_empty': 'Hier komt nog niets uit een Blueprint. Installeer er een uit de Catalogus, of uit een bestand.',
    'solutions.catalogue_intro': 'Een van deze installeren maakt een nieuwe Solution. Alles komt als concept binnen.',
    'solutions.catalogue_empty': 'Er zijn nog geen Blueprints op deze installatie bewaard. Publiceer een Solution, dan staat hij hier voor collega\'s om te installeren.',

    // ── Eén kaart ─────────────────────────────────────────────
    'solutions.card_role_owner': 'eigenaar',
    'solutions.card_role_editor': 'bewerker',
    'solutions.card_role_viewer': 'lezer',
    'solutions.card_installed_from': 'geïnstalleerd uit een Blueprint',
    'solutions.card_installed_at': 'geïnstalleerd op v{version}',
    'solutions.card_health_clear': 'Compleet',
    'solutions.card_health_blocking': '{count} punt op te lossen',
    'solutions.card_health_blocking_plural': '{count} punten op te lossen',
    'solutions.card_health_advice': '{count} punt om naar te kijken',
    'solutions.card_health_advice_plural': '{count} punten om naar te kijken',
    'solutions.card_health_unread': 'Niet helemaal te lezen',
    'solutions.card_health_unread_hint': 'Een deel van deze Solution kon niet gelezen worden, dus hoeveel er op te lossen valt is niet bekend.',
    'solutions.card_health_unknown': 'Niet gecontroleerd',
    'solutions.card_health_unknown_hint': 'De controles zijn voor deze Solution niet gedraaid — dit is dus geen schone verklaring.',
    'solutions.card_counts_partial': 'Niet alles kon geteld worden: {sections}',
    'solutions.card_runs_today': '{count} run vandaag',
    'solutions.card_runs_today_plural': '{count} runs vandaag',
    'solutions.card_runs_failed': '{count} mislukt',
    'solutions.card_runs_failed_plural': '{count} mislukt',
    'solutions.card_runs_idle': 'Vandaag niets gedraaid',
    'solutions.card_runs_unknown': 'Runs konden niet geteld worden',
    'solutions.card_update_available': 'v{version} beschikbaar',
    'solutions.card_update_any': 'Er is een nieuwere versie',
    'solutions.card_update_unknown': 'Of er een nieuwere versie is, kon niet gecontroleerd worden',
};

/**
 * Runs at boot as well as from the command line, so the strings reach an
 * install without anyone remembering to run a script. That is only safe because
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
        console.log(`[Migration] add-nl-solution-overview-translations applied (+${added} keys)`);
    }
    return { added };
}

// NL_TRANSLATIONS is exported so the colocated test can read the catalogue
// rather than re-parsing it out of the source.
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
