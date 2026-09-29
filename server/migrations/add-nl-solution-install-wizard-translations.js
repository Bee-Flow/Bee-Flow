#!/usr/bin/env node
/**
 * One-time migration: Dutch translations for the install wizard (O3).
 *
 * Usage:  node server/migrations/add-nl-solution-install-wizard-translations.js
 *
 * Merges into the existing i18n_gui_nl config without overwriting any
 * translation that already exists.
 *
 * Same split as add-nl-solution-membership-translations, and for the same
 * reason: descriptive copy is translated, product nouns stay English. So
 * 'Blueprint' and 'Solution' are untouched, and so is a tool name — a tool name
 * is an identifier, and translating one on the Connect step would name
 * something the installer then cannot find in Settings → Integrations.
 */

const NL_TRANSLATIONS = {
    // ── De wizard zelf ─────────────────────────────────────────
    'solutions.install_title': 'Blueprint installeren',
    'solutions.install_step_contents': 'Wat erin zit',
    'solutions.install_step_connect': 'Koppelen',
    'solutions.install_step_access': 'Wie erbij kan',
    'solutions.install_step_done': 'Geïnstalleerd',
    'solutions.install_back': 'Terug',
    'solutions.install_next': 'Volgende',
    'solutions.install_confirm': 'Installeren',
    'solutions.install_open': 'Openen',
    // De zin die op elke stap onder de knoppen staat.
    'solutions.install_footer_draft': 'Alles komt als concept binnen.',

    // ── 1 Inhoud ───────────────────────────────────────────────
    'solutions.install_name': 'Naam voor deze Solution',
    'solutions.install_contains': 'Wat hij meebrengt',
    'solutions.install_count_automations': '{count} routine',
    'solutions.install_count_automations_plural': '{count} routines',
    'solutions.install_count_apps': '{count} app',
    'solutions.install_count_apps_plural': '{count} apps',
    'solutions.install_count_webpages': '{count} webpage',
    'solutions.install_count_webpages_plural': '{count} webpages',
    'solutions.install_count_datatables': '{count} tabel',
    'solutions.install_count_datatables_plural': '{count} tabellen',
    'solutions.install_count_agents': '{count} agent',
    'solutions.install_count_agents_plural': '{count} agents',
    'solutions.install_count_knowledge_bases': '{count} kennisbank',
    'solutions.install_count_knowledge_bases_plural': '{count} kennisbanken',
    'solutions.install_nothing_in_it': 'Deze Blueprint bevat helemaal niets.',
    'solutions.install_loading': 'Blueprint wordt gelezen…',
    'solutions.install_unreadable': 'Deze Blueprint kon niet gelezen worden, dus er valt niets te beschrijven en er is niets geïnstalleerd.',
    'solutions.install_gallery_failed': 'De Blueprints op deze installatie konden niet worden opgehaald — dat is dus niet "er zijn er geen". Installeren vanuit een bestand werkt gewoon.',

    // ── 2 Koppelen ─────────────────────────────────────────────
    'solutions.install_connect_intro': 'Hier is niets van meegekomen met het bestand. Beantwoord wat je kunt; wat je open laat, stel je later in de Solution in.',
    'solutions.install_connect_none': 'Hier hoeft niets gekoppeld te worden.',
    'solutions.install_list_failed': 'Die lijst kon niet worden geladen, dus wat je hier kunt kiezen is niet het hele verhaal.',
    'solutions.install_at_step': 'stap {step}',
    'solutions.install_in_routine': 'in {name}',
    'solutions.install_in_flowlet': 'flowlet {key}',
    'solutions.install_table_for': 'Een tabel voor "{key}"',
    'solutions.install_used_by_steps': 'Gebruikt door {count} stap',
    'solutions.install_used_by_steps_plural': 'Gebruikt door {count} stappen',
    'solutions.install_table_pick': 'Kies een tabel…',
    'solutions.install_table_create': 'Maak een lege tabel',
    'solutions.install_connection_for': 'Een inloggegeven voor deze aanvraag',
    'solutions.install_connection_pick': 'Laat leeg',
    'solutions.install_approver_for': 'Wie hier goedkeurt',
    'solutions.install_approver_owner': 'Laat het aan de eigenaar van de Solution',

    // ── 2 Koppelen: wat het bestand vraagt ─────────────────────
    'solutions.install_grants_title': 'Wat het bestand zijn webpages wil laten doen',
    'solutions.install_grants_intro': 'De tools van een webpage draaien als degene die hem installeert, dus een installatie geeft hier niets van weg. Vink aan wat je zelf wilt toekennen.',
    'solutions.install_grant_tool': 'Laat "{page}" {tool} gebruiken',
    'solutions.install_grant_connected': 'Gekoppeld aan jouw account',
    'solutions.install_grant_status_unknown': 'Of deze app gekoppeld is kon niet worden gecontroleerd, dus hij kan hier niet worden toegekend — ken hem daarna op de pagina toe.',
    'solutions.install_grant_not_connected': 'Niet gekoppeld aan jouw account — koppel hem in Instellingen → Integraties en ken hem daarna op de pagina toe.',
    'solutions.install_grant_public_ai': '"{page}" vraagt om anonieme bezoekers jouw AI-budget te laten uitgeven.',
    'solutions.install_grant_public_ai_cap': 'Hij vraagt om maximaal ${cap} per dag. Installeren zet dit nooit aan — open de pagina en beslis daar.',
    'solutions.install_grant_public_ai_off': 'Installeren zet dit nooit aan — open de pagina en beslis daar.',
    'solutions.install_grant_foreign_routine': '"{page}" wil een routine draaien die niet in dit bestand zit.',
    'solutions.install_grant_foreign_routine_hint': 'Hij noemde er een op de installatie waar het bestand vandaan komt, dus hier is niets om naar te wijzen. Open de pagina en ken er een van jezelf toe.',
    'solutions.install_grant_failed': '{tool} kon niet worden toegekend: {why}',
    'solutions.install_grant_no_page': '{tool} kon niet worden toegekend: die pagina is niet geïnstalleerd.',
    'solutions.install_share_failed': '{who} kon niet worden toegevoegd: {why}',
    'solutions.install_unreachable': 'de server was niet bereikbaar',

    // ── 3 Toegang ──────────────────────────────────────────────
    'solutions.install_access_intro': 'Wie er verder bij deze Solution kan. Je installeert hem hoe dan ook als eigenaar, en je kunt dit later op de projectpagina wijzigen.',
    'solutions.install_access_kind': 'Personen of groepen',
    'solutions.install_access_person': 'Persoon',
    'solutions.install_access_group': 'Groep',
    'solutions.install_access_who': 'Wie je toevoegt',
    'solutions.install_access_pick': 'Kies…',
    'solutions.install_access_role': 'Wat ze mogen',
    'solutions.install_access_add': 'Toevoegen',
    'solutions.install_access_remove': 'Verwijderen',
    'solutions.install_access_none': 'Voorlopig niemand anders.',
    'solutions.install_role_viewer': 'Mag bekijken',
    'solutions.install_role_editor': 'Mag bewerken',

    // ── Na afloop ──────────────────────────────────────────────
    'solutions.install_installed': 'Geïnstalleerd.',
    'solutions.install_result_grants': 'Nog toe te kennen, op de pagina\'s zelf',
};

/**
 * Merge the catalogue into the Dutch GUI translations.
 */
async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-solution-install-wizard-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up };

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
