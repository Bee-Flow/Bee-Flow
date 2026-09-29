#!/usr/bin/env node
/**
 * One-time migration: Dutch translations for Solution membership — the two
 * sections that complete a project's contents, webpages and approvals.
 *
 * Usage:  node server/migrations/add-nl-solution-membership-translations.js
 *
 * Merges into the existing i18n_gui_nl config without overwriting any
 * translation that already exists.
 *
 * Note the split, which is the house convention rather than an oversight:
 * descriptive copy is translated, but the product nouns stay English. That is
 * why 'Goedkeuringen' appears here (it matches studio.tab.approvals, already
 * translated) while 'Webpages' does not (it matches sidebar.apps → 'Apps' and
 * sidebar.cowork → 'Cowork', deliberately kept as loanwords).
 */

const NL_TRANSLATIONS = {
    // ── Projectbronnen ─────────────────────────────────────────
    'projects.webpages': 'Webpages',
    'projects.approvals': 'Goedkeuringen',

    // ── Overzicht ──────────────────────────────────────────────
    'projects.running_now': 'Draait nu',
    'projects.recent_activity': 'Recente activiteit',
    // 'Routine' is wat de goedkeuringenkaarten een automation noemen
    // (zie add-nl-approvals-translations.js) — hier hetzelfde woord.
    'projects.untitled_automation': 'Naamloze routine',
    // ── Flow ───────────────────────────────────────────────────
    'projects.flow_health': 'Status',
    'projects.flow_wiring': 'Hoe het samenhangt',
    'projects.flow_externals': 'Hangt af van dingen buiten dit project',
    'projects.flow_all_connected': 'Alles in dit project is verbonden en heeft dezelfde eigenaar.',
    'projects.flow_nothing_wired': 'Nog niets in dit project roept iets anders aan.',
    'projects.flow_nothing_picked': 'nog niets gekozen',
    'projects.flow_used_by': 'gebruikt door',
    // ── Blueprint ──────────────────────────────────────────────
    // 'Blueprint' en 'Solution' blijven Engels — productnamen, net als Apps.
    'projects.blueprint_intro': 'Een Blueprint is deze Solution op schrift — de routines, apps en webpages, én de verbindingen ertussen — zodat je hem ergens anders kunt installeren. Beslissingen, inloggegevens en personen gaan nooit mee.',
    'projects.blueprint_export': 'Deze Solution inpakken',
    'projects.blueprint_download': 'Downloaden',
    'projects.blueprint_owner_only': 'Alleen de eigenaar van het project kan het inpakken.',
    'projects.blueprint_requires': 'Wie hem installeert moet zelf leveren',
    'projects.blueprint_left_behind': 'Wat deze Blueprint niet meeneemt',
    'projects.blueprint_install': 'Blueprint installeren',
    'projects.blueprint_not_json': 'Dat bestand is geen Blueprint.',
    'projects.blueprint_locked': 'Een Blueprint installeren hoort niet bij dit abonnement.',
    'projects.blueprint_install_failed': 'De installatie is mislukt.',
    'projects.blueprint_skipped': 'Niet geïnstalleerd',
    'projects.blueprint_keep_here': 'Bewaar hem ook op deze installatie, zodat collega\'s hem zonder bestand kunnen installeren',
    'projects.blueprint_saved_here': 'Bewaard op deze installatie',

    // ── Studio → Solutions ─────────────────────────────────────
    // 'Solutions' en 'Blueprint' blijven Engels — productnamen, net als Apps.
    'studio.tab.solutions': 'Solutions',
    'studio.tab.solutions_desc': 'Bundel routines, apps en webpages tot één installeerbare Solution',
    'solutions.title': 'Solutions',
    'solutions.intro': 'Een Solution bundelt routines, apps en webpages die samenwerken — en pakt in als een Blueprint die je ergens anders installeert.',
    'solutions.new': 'Nieuwe Solution',
    'solutions.name_placeholder': 'Geef de Solution een naam…',
    'solutions.create_failed': 'Aanmaken is niet gelukt.',
    'solutions.empty': 'Nog niets hier. Maak een Solution, of installeer een Blueprint die iemand je gaf.',
    'solutions.back': 'Alle Solutions',
    'solutions.open_project': 'Openen in Projecten',
    'solutions.tab_overview': 'Overzicht',
    'solutions.tab_content': 'Inhoud',
    'solutions.tab_flow': 'Flow',
    'solutions.tab_blueprint': 'Blueprint',
};

/**
 * Runs at boot as well as from the command line, so the strings reach an
 * install without anyone remembering to run a script. That is only safe
 * because `up()` NEVER exits the process — the sibling migrations wired into
 * index.js all keep process.exit() inside the require.main branch below, and
 * one that exited in up() would take the server down on start.
 *
 * Idempotent: only keys with no Dutch value yet are filled, so re-running it
 * cannot overwrite a translation somebody has since corrected by hand.
 */
async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-solution-membership-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up };

if (require.main === module) {
    up().then((r) => {
        console.log(r.added === 0
            ? 'All translations already exist. Nothing to do.'
            : `✓ Done! Total NL translations: ${r.total}`);
        process.exit(0);
    }).catch(err => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
}
