#!/usr/bin/env node
/**
 * Dutch for the Studio shared patterns (Track 0 of the 2026-09 Studio redesign).
 *
 * Every Studio section — automations, tables, apps, webpages, forms, agents,
 * skills, knowledge bases, meeting notes, solutions — now renders the same
 * chrome: one section header (StudioSectionHeader), one status capsule
 * (StatusActionPill), one publish capsule (VisibilityCapsule: Persoonlijk /
 * Organisatie / Groepen), one "Gebruikt door" tab (UsedByTab), one danger zone
 * and one "Nieuw" menu. The keys below are that chrome's copy; the per-section
 * body copy ships in its own add-nl-<track>-translations.js as each track lands.
 *
 * WHY DUTCH FIRST: the publish capsule and the danger zone are the two places
 * a person widens who can see their data, or deletes something other things
 * depend on. "Iedereen in je organisatie kan dit straks zien en gebruiken" and
 * "typ de naam ter bevestiging" are consent sentences, and a consent sentence
 * in a second language is not consent. This is a Dutch privacy product.
 *
 * Words follow the design artboards (Studio Home 1b, Studio Nav): the nav
 * groups are Bouwen / AI / Bundelen / Add-ons; the capsule says Persoonlijk /
 * Organisatie / Groepen; the tab is "Gebruikt door"; the split button is
 * "Nieuw" with "Beschrijf het — AI kiest de bouwstenen" as its first row; the
 * statuses are Live / Concept / Gepauzeerd / Verouderd. "Dit account", never
 * "jij", for the same reason as add-nl-datatables-translations.js: on a
 * self-hosted install the built-in admin login is shared between operators.
 *
 * Some English words are the Dutch words (Live, App, Agent, Skill, Automation,
 * "{n} {kind}"). Those are listed in SAME_AS_ENGLISH rather than in
 * NL_TRANSLATIONS, so that the test which refuses an untranslated value can
 * tell "deliberately identical" from "forgot".
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated its
 * own wording keeps it. ADD, NEVER RENAME — a renamed key is a screen that
 * silently falls back to English. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-studio-fundament-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Statuscapsule ───────────────────────────────────────────────────────
    'studio.status.paused': 'Gepauzeerd',
    'studio.status.draft': 'Concept',
    'studio.status.published': 'Gepubliceerd',
    'studio.status.stale': 'Verouderd',
    'studio.status.unknown': 'Onbekend',
    'studio.status.republish': 'Opnieuw publiceren',

    // ── Navigatiegroepen en gating ──────────────────────────────────────────
    'studio.category.build': 'Bouwen',
    'studio.category.bundle': 'Bundelen',
    'studio.category.modules': 'Add-ons',
    'studio.locked_not_granted': 'Niet ingeschakeld voor je organisatie — vraag een beheerder',
    'studio.locked_upgrade': 'Beschikbaar in een hoger plan',

    // ── Het ene "Nieuw"-menu ────────────────────────────────────────────────
    'studio.new.button': 'Nieuw',
    'studio.new.open_menu': 'Open het menu Nieuw',
    'studio.new.ai': 'Beschrijf het — AI kiest de bouwstenen',
    'studio.new.failed': 'Kon het niet aanmaken.',
    'studio.new.datatable': 'Tabel',
    'studio.new.webpage': 'Webpagina',
    'studio.new.form': 'Formulier',
    'studio.new.knowledge': 'Kennisbank',
    'studio.new.meeting': 'Een meeting opnemen of uploaden',
    'studio.new.solution': 'Oplossing',
    'studio.new.untitled_automation': 'Automation zonder naam',
    'studio.new.untitled_form': 'Formulier zonder naam',

    // ── De ene kop ──────────────────────────────────────────────────────────
    'studio.header.back': 'Terug',
    'studio.header.untitled': 'Zonder naam',
    'studio.header.rename': 'Hernoemen',
    'studio.header.rename_hint': 'Klik om te hernoemen',
    'studio.header.tabs': 'Onderdelen',

    // ── Publiceer-capsule ───────────────────────────────────────────────────
    'visibility.personal': 'Persoonlijk',
    'visibility.personal_desc': 'Alleen dit account heeft toegang',
    'visibility.entire_org': 'Organisatie',
    'visibility.entire_org_desc': 'Alle leden hebben toegang',
    'visibility.groups': 'Groepen',
    'visibility.group_named': 'Groep {name}',
    'visibility.one_group': '1 groep',
    'visibility.n_groups': '{count} groepen',
    'visibility.names_and': '{head} en {last}',
    'visibility.title': 'Publiceren naar…',
    'visibility.choose_who': 'Kies wie dit kan zien.',
    'visibility.or_specific_groups': 'Of bepaalde groepen',
    'visibility.no_groups_available': 'Nog geen groepen in deze organisatie.',
    'visibility.groups_unreadable': 'De lijst met groepen kon niet worden gelezen, dus delen met bepaalde groepen wordt nu even niet aangeboden. Dat is iets anders dan “deze organisatie heeft geen groepen”.',
    'visibility.groups_retry': 'Opnieuw proberen',
    'visibility.embed_hint': 'Web-embed staat aan — beheer die onder Gedrag.',
    'visibility.aria_label': 'Zichtbaarheid',
    'visibility.add_group': 'Groep toevoegen',
    'visibility.remove_group': '{name} verwijderen',
    'visibility.last_group_hint': 'Kies Persoonlijk om te stoppen met delen',
    'visibility.this_item': 'dit onderdeel',
    'visibility.confirm_title': 'Breder delen?',
    'visibility.confirm_share': 'Delen',
    'visibility.confirm_keep': 'Laat het zoals het is',
    'visibility.confirm_org': 'Iedereen in je organisatie kan “{name}” straks zien en gebruiken.',
    'visibility.confirm_groups': 'Leden van {groups} kunnen “{name}” straks zien en gebruiken.',

    // ── Gebruikt door ───────────────────────────────────────────────────────
    'usage.loading': 'Laden wie dit gebruikt…',
    'usage.error': 'Kon niet laden wie dit gebruikt — de lijst kan onvolledig zijn.',
    'usage.empty': 'Nog niets gebruikt dit.',
    'usage.empty_incomplete': 'Er is niets gevonden — maar niet alles kon worden gecontroleerd.',
    'usage.table_label': 'Gebruikt door',
    'usage.head_where': 'Waar',
    'usage.head_does': 'Doet',
    'usage.head_last': 'Laatste keer',
    'usage.head_open': 'Openen',
    'usage.pill_unused': 'door niets gebruikt',
    'usage.pill_unknown': 'niet volledig gecontroleerd',
    'usage.someone_elses': 'van iemand anders',
    'usage.someone_elses_kind': '{kind} van iemand anders',
    'usage.untitled_kind': '{kind} zonder naam',
    'usage.role_read': 'leest',
    'usage.role_write': 'schrijft',
    'usage.role_readwrite': 'leest en schrijft',
    'usage.role_contains': 'bevat',
    'usage.role_invokes': 'roept aan',
    'usage.role_chat': 'gesprekspartner',
    'usage.role_ai_step': 'AI-stap',
    'usage.role_answer_block': 'antwoordblok',
    'usage.kind_datatable': 'tabel',
    'usage.kind_datatable_plural': 'tabellen',
    'usage.kind_webpage': 'webpagina',
    'usage.kind_webpage_plural': 'webpagina’s',
    'usage.kind_form': 'formulier',
    'usage.kind_form_plural': 'formulieren',
    'usage.kind_kb': 'kennisbank',
    'usage.kind_kb_plural': 'kennisbanken',
    'usage.kind_solution': 'oplossing',
    'usage.kind_solution_plural': 'oplossingen',
    'usage.kind_project_plural': 'projecten',
    'usage.kind_other': 'onderdeel',
    'usage.kind_other_plural': 'onderdelen',

    // ── Verwijderen ─────────────────────────────────────────────────────────
    'usage.delete_open': '{kind} verwijderen',
    'usage.delete_group': 'Verwijderen',
    'usage.delete_question': '“{name}” definitief verwijderen?',
    'usage.checking': 'Controleren wie dit gebruikt…',
    'usage.delete_dependents_one': 'Eén ding gebruikt dit en gaat falen:',
    'usage.delete_dependents': '{n} dingen gebruiken dit en gaan falen:',
    'usage.delete_nothing_depends': 'Niets gebruikt dit. Het kan verwijderd worden zonder iets anders te breken.',
    'usage.delete_dependents_incomplete': 'En deze lijst is niet het hele verhaal — niet alles kon worden gecontroleerd.',
    'usage.delete_nothing_found_incomplete': 'Er is niets gevonden — maar niet alles kon worden gecontroleerd, dus dit is niet hetzelfde als “niets gebruikt dit”.',
    'usage.delete_type_name': 'Typ de naam ter bevestiging.',
    'usage.in_use_refreshed': 'Iets gebruikt dit nog. De lijst hieronder is ververst — typ de naam opnieuw ter bevestiging.',
    'usage.err_delete': 'Kon “{name}” niet verwijderen',
    'usage.cancel': 'Annuleren',
    'usage.delete_confirm': 'Definitief verwijderen',
};

/**
 * Keys whose Dutch IS the English string. Kept out of NL_TRANSLATIONS on
 * purpose: writing "Live": "Live" into the nl store would pin a value that
 * cannot be told apart from an untranslated one, and t() already falls back to
 * English for a missing key. The test uses this list to distinguish
 * "deliberately identical" from "forgotten". "Automation" (not "routine")
 * follows the artboards' nav wording; the datatables section still says
 * "routine" in its own copy, which is a known, older choice.
 */
const SAME_AS_ENGLISH = [
    'studio.status.live',
    'studio.category.ai',
    'studio.new.automation',
    'studio.new.app',
    'studio.new.agent',
    'studio.new.skill',
    'studio.new.document',
    'usage.pill_count',
    'usage.kind_automation',
    'usage.kind_automation_plural',
    'usage.kind_app',
    'usage.kind_app_plural',
    'usage.kind_agent',
    'usage.kind_agent_plural',
    'usage.kind_skill',
    'usage.kind_skill_plural',
    'usage.kind_meeting',
    'usage.kind_meeting_plural',
    'usage.kind_chat',
    'usage.kind_chat_plural',
    'usage.kind_project',
    'usage.kind_notebook',
    'usage.kind_notebook_plural',
];

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomair over replica's heen (advisory lock in mutateConfig); bestaande
    // waarden winnen — alleen ontbrekende sleutels komen erbij.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-studio-fundament-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-studio-fundament-translations failed:', e.message);
        process.exit(1);
    });
}
