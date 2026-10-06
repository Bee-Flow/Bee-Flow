#!/usr/bin/env node
/**
 * Dutch for the Forms section (2026-09): the directory, the Form page
 * (Vragen · Delen · Antwoorden · Instellingen), the "Nieuw formulier" dialog,
 * the answers dashboard, and the form-answers half of the Datatables section
 * (`datatables.frm_*`).
 *
 * The directory's own keys (`forms.studio.*`, `forms.status.*`,
 * `sidebar.forms*`, `studio.tab.forms_desc`) had no Dutch before this
 * catalogue: a list and the page behind it share one screen and a
 * half-Dutch directory is worse than an English one, so they are translated
 * here too.
 *
 * Terminology: a form is a "formulier", a question a "vraag", what somebody
 * gave an "antwoord", one filled-in form an "inzending"; the answers live in
 * a "tabel" (never "datatabel" on the Forms side — the person there thinks
 * in forms), reading them is "bekijken", sharing "delen", the dashboard stays
 * "dashboard". A retired question is "niet meer op het formulier". And "dit
 * account", never "jij" — the reason the sibling catalogues state.
 *
 * Idempotent, ADD NEVER RENAME (a renamed key is a screen that silently
 * falls back to English), auto-runs from server boot (boot/bootMigrations.js).
 * Manual usage:
 *   node server/migrations/add-nl-forms-answers-translations.js
 */

const NL_TRANSLATIONS = {
    // ── the directory (Studio → Forms) and its sidebar row ─────────────
    'sidebar.forms': 'Formulieren',
    'sidebar.all_forms': 'Alle formulieren',
    'sidebar.all_forms_desc': 'Elk formulier dat in de organisatie is gepubliceerd',
    'studio.tab.forms_desc': 'Gepubliceerde formulieren, en wat ze starten',
    'forms.studio.intro': 'Een formulier is de voorkant van een automatisering: wie het invult, start hem. Een gepubliceerd formulier heeft een adres dat iedereen in de organisatie na inloggen kan openen, dus het hoort bij de organisatie en niet bij één persoon.',
    'forms.studio.new': 'Nieuw formulier',
    'forms.studio.new_failed': 'Het formulier kon niet worden aangemaakt.',
    'forms.studio.refresh': 'Lijst verversen',
    'forms.studio.retry': 'Opnieuw proberen',
    'forms.studio.loading': 'Formulieren laden…',
    'forms.studio.load_failed': 'De formulieren konden niet worden geladen — dit is geen lege lijst.',
    'forms.studio.empty_title': 'Nog geen formulieren',
    'forms.studio.empty_body': 'Een formulier is een pagina die de collega’s met wie het wordt gedeeld kunnen invullen. Maak er een en het verschijnt hier.',
    'forms.studio.count': '{count} formulier',
    'forms.studio.count_plural': '{count} formulieren',
    'forms.studio.untitled': 'Naamloos formulier',
    'forms.studio.copy_link': 'Link kopiëren',
    'forms.studio.copied': 'Link gekopieerd',
    'forms.studio.copy_failed': 'De link kon niet worden gekopieerd — de browser weigerde toegang tot het klembord.',
    'forms.studio.open_automation': 'Automatisering openen',
    'forms.studio.not_yours': 'Gemaakt door een collega — alleen die kan de automatisering erachter openen',
    'forms.studio.last_submission': 'laatste {when}',
    'forms.studio.submissions': '{count} inzending',
    'forms.studio.submissions_plural': '{count} inzendingen',
    'forms.studio.answers_btn': 'Antwoorden · {count} inzending',
    'forms.studio.answers_btn_plural': 'Antwoorden · {count} inzendingen',
    'forms.studio.collects_chip': 'verzamelt antwoorden',
    'forms.studio.open_named': '{title} openen',
    'forms.status.live_hint': 'Collega\'s in de organisatie kunnen dit na inloggen invullen.',
    'forms.status.off': 'Niet live',
    'forms.status.off_hint': 'De automatisering erachter is gepauzeerd of nog een concept, dus de link antwoordt "niet beschikbaar".',
    'forms.status.unknown': 'Status onbekend',
    'forms.status.unknown_hint': 'Deze rij zei niet of het formulier live is. Open de automatisering om het na te kijken.',

    // ── "Nieuw formulier" ───────────────────────────────────────────────
    'forms.new.title': 'Nieuw formulier',
    'forms.new.name_label': 'Naam',
    'forms.new.name_placeholder': 'Klanttevredenheid',
    'forms.new.mode_legend': 'Wat gebeurt er met de antwoorden?',
    'forms.new.collect_title': 'Antwoorden verzamelen in een tabel',
    'forms.new.recommended': 'Aanbevolen',
    'forms.new.collect_blurb': 'Er wordt een tabel gemaakt met één kolom per vraag, die met het formulier meegroeit. Elk antwoord staat erin zodra iemand het formulier verstuurt, en wie de tabel gedeeld krijgt ziet de antwoorden op een dashboard.',
    'forms.new.automation_title': 'Formulier dat een automatisering start',
    'forms.new.automation_blurb': 'Elke inzending start de stappen die in de automatiseringsbouwer worden gebouwd — een e-mail sturen, een ticket aanmaken, een agent iets vragen. Geen tabel, tenzij er een wordt toegevoegd.',
    'forms.share.link_blurb_restricted': 'Alleen de personen en groepen onder “Wie kan het invullen” kunnen deze link openen, na aanmelden. De link werkt alleen zolang het formulier live is.',
    'forms.share.audience_title': 'Wie kan het invullen',
    'forms.share.audience_restricted': 'Alleen de personen en groepen die worden gekozen',
    'forms.share.audience_restricted_desc': 'Collega’s die hieronder staan, en de leden van de groepen die hieronder staan. Niemand anders in de organisatie — en nooit iemand daarbuiten.',
    'forms.share.audience_org': 'Iedereen in de organisatie',
    'forms.share.audience_org_desc': 'Elke aangemelde collega met de link. Nooit iemand buiten de organisatie.',
    'forms.share.audience_empty': 'Nog niemand — alleen dit account kan het formulier openen. Voeg de personen of groepen toe voor wie het bedoeld is.',
    'forms.share.audience_group': 'Een groep — elk lid',
    'forms.share.audience_group_short': 'Een groep',
    'forms.share.audience_person': 'Een persoon',
    'forms.share.audience_remove': '{name} verwijderen',
    'forms.share.audience_add': 'Een persoon of groep toevoegen',
    'forms.share.audience_kind': 'Een persoon of een groep',
    'forms.share.audience_who': 'Wie',
    'forms.share.audience_pick_person': 'Kies iemand…',
    'forms.share.audience_pick_group': 'Kies een groep…',
    'forms.share.audience_add_confirm': 'Toevoegen',
    'forms.share.audience_failed': 'Kon niet wijzigen wie het formulier kan invullen.',
    'forms.share.audience_widen_title': 'Het formulier openstellen voor de hele organisatie?',
    'forms.share.audience_widen_body': 'Elke aangemelde collega met de link kan het dan invullen. De personen en groepen in de lijst blijven staan, voor als het later weer wordt beperkt.',
    'forms.share.audience_widen_confirm': 'Openstellen voor iedereen',
    'forms.share.audience_widen_cancel': 'De lijst houden',
    'forms.studio.audience_restricted': 'Gedeeld met {count} persoon of groep',
    'forms.studio.audience_restricted_plural': 'Gedeeld met {count} personen en groepen',
    'forms.studio.audience_nobody': 'Alleen dit account — nog niet gedeeld',
    'forms.studio.audience_org': 'Iedereen in de organisatie',
    'forms.ai.title': 'Bouwen met AI',
    'forms.ai.intro': 'Beschrijf het formulier, of plak waarop het gebaseerd moet zijn — een intakechecklist, een e-mail, een beleidstekst. De vragen worden hieronder opgesteld om na te lezen; er wordt niets opgeslagen tot er wordt opgeslagen.',
    'forms.ai.intro_revise': 'Zeg wat er anders moet. De vragen die blijven, blijven zoals ze zijn — en hun antwoorden ook.',
    'forms.ai.mode_label': 'Wat de AI doet',
    'forms.ai.mode_revise': 'De huidige vragen aanpassen',
    'forms.ai.mode_create': 'Opnieuw beginnen vanuit een beschrijving',
    'forms.ai.placeholder': 'bijv. Een verlofaanvraag: naam, afdeling, eerste en laatste dag, een reden, en of een collega waarneemt. Of plak de checklist die het formulier moet volgen.',
    'forms.ai.placeholder_revise': 'bijv. voeg een telefoonnummer toe, maak het adres optioneel, kortere labels',
    'forms.ai.done': '{count} vraag opgesteld — lees hem hieronder na en sla op.',
    'forms.ai.done_plural': '{count} vragen opgesteld — lees ze hieronder na en sla op.',
    'forms.ai.undo': 'Ongedaan maken',
    'forms.ai.running': 'Bezig met opstellen…',
    'forms.ai.run': 'Vragen opstellen',
    'forms.ai.run_revise': 'Vragen aanpassen',
    'forms.ai.err_no_model': 'Er is nog geen AI-model ingesteld voor deze werkruimte.',
    'forms.ai.err_unusable': 'De AI gaf geen bruikbaar formulier terug. Probeer het opnieuw, of beschrijf het concreter.',
    'forms.ai.err_no_text': 'Typ of plak eerst iets.',
    'forms.ai.err_rate': 'Te veel concepten in één minuut — wacht even en probeer het opnieuw.',
    'forms.ai.err_failed': 'De vragen konden niet worden opgesteld.',
    'forms.new.brief_label': 'Beschrijf het (optioneel)',
    'forms.new.brief_placeholder': 'Wat moet het formulier vragen? Eén zin is genoeg — of plak de checklist, e-mail of beleidstekst waarop het gebaseerd moet zijn.',
    'forms.new.brief_hint': 'AI stelt hieruit de vragen op in het volgende scherm. Die worden nagelezen voordat er iets wordt opgeslagen.',
    'forms.new.create': 'Formulier maken',
    'forms.new.cancel': 'Annuleren',
    'forms.new.failed': 'Het formulier kon niet worden aangemaakt.',

    // ── the Form page ──────────────────────────────────────────────────
    'forms.page.back': 'Alle formulieren',
    'forms.page.tab_questions': 'Vragen',
    'forms.page.tab_share': 'Delen',
    'forms.page.tab_answers': 'Antwoorden',
    'forms.page.tab_settings': 'Instellingen',
    'forms.page.tabs_label': 'Dit formulier',
    'forms.page.open_form': 'Formulier openen',
    'forms.page.open_new_tab': 'In een nieuw tabblad openen',
    'forms.page.not_found': 'Dit formulier is niet beschikbaar voor dit account.',
    'forms.page.load_failed': 'Het formulier kon niet worden geladen.',
    'forms.page.loading': 'Formulier laden…',
    'forms.page.loading_editor': 'De editor laden…',
    'forms.page.readonly_chip': 'gedeeld met dit account',
    'forms.page.readonly_hint': 'Gedeeld met dit account via de antwoordentabel — de vragen en instellingen zijn van de eigenaar van het formulier.',
    'forms.page.save': 'Opslaan',
    'forms.page.discard': 'Wijzigingen weggooien',
    'forms.page.saved': 'Opgeslagen.',
    'forms.page.save_failed': 'Het formulier kon niet worden opgeslagen.',
    'forms.page.unsaved_title': 'Niet-opgeslagen wijzigingen',
    'forms.page.unsaved_body': 'De vragen zijn gewijzigd en niet opgeslagen. Weggaan en de wijzigingen verliezen?',
    'forms.page.unsaved_leave': 'Weggaan',
    'forms.page.unsaved_stay': 'Verder bewerken',
    'forms.page.pages_note': '{count} pagina extra — bewerk die in de automatisering',
    'forms.page.pages_note_plural': '{count} pagina\'s extra — bewerk die in de automatisering',
    'forms.page.columns_note': 'Elke vraag hier is een kolom in de antwoordentabel. Een vraag hernoemen hernoemt de kolom; een vraag verwijderen laat de kolom staan, gemarkeerd als "niet meer op het formulier".',

    // ── Delen ──────────────────────────────────────────────────────────
    'forms.share.link_title': 'Link naar het formulier',
    'forms.share.link_blurb': 'Collega\'s in de organisatie kunnen deze link na inloggen openen. Hij werkt alleen zolang het formulier live is.',
    'forms.share.link_label': 'Adres van het formulier',
    'forms.share.link_generating': 'De link wordt gemaakt — sla het formulier één keer op en hij verschijnt hier.',
    'forms.share.link_rotate': 'Nieuwe link',
    'forms.share.link_rotate_title': 'Een nieuwe link maken?',
    'forms.share.link_rotate_body': 'De huidige link werkt meteen niet meer — wie hem al heeft, ziet "niet beschikbaar".',
    'forms.share.link_rotate_confirm': 'Nieuwe link maken',
    'forms.share.answers_title': 'Wie de antwoorden mag zien',
    'forms.share.answers_blurb': 'De antwoorden staan in een tabel. De tabel delen is het dashboard delen: wie de tabel kan lezen, kan hier Antwoorden openen en het tabblad Dashboard op de tabel.',
    'forms.share.open_table': 'Tabel openen',
    'forms.share.no_table': 'Dit formulier verzamelt zijn antwoorden niet in een tabel. Zet dat aan onder Instellingen om een dashboard te delen.',

    // ── Instellingen ───────────────────────────────────────────────────
    'forms.settings.live_toggle': 'Formulier is live',
    'forms.settings.live_off_blurb': 'Uitgeschakeld: de link antwoordt "niet beschikbaar" en er wordt niets verzameld.',
    'forms.settings.live_failed': 'Het formulier kon niet worden ingeschakeld.',
    'forms.settings.collect_title': 'Antwoorden verzamelen in een tabel',
    'forms.settings.collect_toggle': 'Antwoorden verzamelen in een tabel',
    'forms.settings.collect_on': 'Aan — elke inzending wordt een rij in de antwoordentabel.',
    'forms.settings.collect_off_blurb': 'Zet aan om een tabel te maken met één kolom per vraag. Eerdere inzendingen worden niet ingelezen; het verzamelen begint bij de volgende.',
    'forms.settings.collect_pending': 'De tabel is er nog niet — sla het formulier nog eens op, of probeer het opnieuw.',
    'forms.settings.write_error': 'De laatste inzending kon niet naar de tabel worden geschreven: {message}',
    'forms.settings.stop_title': 'Stoppen met verzamelen?',
    'forms.settings.stop_body': 'Nieuwe inzendingen komen niet meer in de tabel. De tabel, de rijen en de deling blijven zoals ze zijn.',
    'forms.settings.stop_confirm': 'Stoppen met verzamelen',
    'forms.settings.retention_title': 'Hoe lang antwoorden bewaard blijven',
    'forms.settings.retention_blurb': 'Antwoorden blijven in de tabel staan tot er een bewaartermijn op de tabel is ingesteld.',
    'forms.settings.retention_open': 'Bewaarinstellingen van de tabel openen',
    'forms.settings.kind_word': 'formulier',
    'forms.settings.delete_open': 'Dit formulier verwijderen',
    'forms.settings.delete_notice': 'Het formulier verwijderen verwijdert de automatisering erachter. De antwoordentabel blijft staan — haal die weg onder Datatabellen als de antwoorden niet meer nodig zijn.',

    // ── Antwoorden (het dashboard) ─────────────────────────────────────
    'forms.answers.label': 'Antwoordendashboard',
    'forms.answers.range_label': 'Periode',
    'forms.answers.range_today': 'Vandaag',
    'forms.answers.range_7d': '7 dagen',
    'forms.answers.range_30d': '30 dagen',
    'forms.answers.range_90d': '90 dagen',
    'forms.answers.range_all': 'Alles',
    'forms.answers.range_custom': 'Zelf kiezen',
    'forms.answers.range_from': 'Van',
    'forms.answers.range_to': 'Tot',
    'forms.answers.updated': 'Bijgewerkt {when}',
    'forms.answers.refresh': 'Verversen',
    'forms.answers.kpi_in_range': 'Inzendingen in deze periode',
    'forms.answers.kpi_all': 'Allemaal',
    'forms.answers.kpi_today': 'Vandaag',
    'forms.answers.kpi_completion': 'Alle pagina\'s afgerond',
    'forms.answers.kpi_last': 'Laatste inzending',
    'forms.answers.kpi_never': 'Nog geen',
    'forms.answers.timeline_title': 'Inzendingen in de tijd',
    'forms.answers.timeline_day': 'per dag',
    'forms.answers.timeline_month': 'per maand',
    'forms.answers.q_answered': '{n} beantwoord',
    'forms.answers.q_skipped': '{n} overgeslagen',
    'forms.answers.q_more': '{n} meer',
    'forms.answers.q_yes': 'Ja',
    'forms.answers.q_no': 'Nee',
    'forms.answers.q_avg': 'Gemiddeld',
    'forms.answers.q_median': 'Mediaan',
    'forms.answers.q_min': 'Laagste',
    'forms.answers.q_max': 'Hoogste',
    'forms.answers.q_recent': 'Meest recente antwoorden',
    'forms.answers.q_see_all': 'Alle antwoorden bekijken',
    'forms.answers.q_files': '{count} bestand',
    'forms.answers.q_files_plural': '{count} bestanden',
    'forms.answers.q_files_open': 'Rijen openen',
    'forms.answers.q_none': 'Geen antwoorden in deze periode.',
    'forms.answers.retired_title': 'Niet meer op het formulier',
    'forms.answers.retired_hint': 'Vragen die van het formulier zijn gehaald. Hun antwoorden staan nog in de tabel.',
    'forms.answers.recent_title': 'Recente inzendingen',
    'forms.answers.recent_open': 'Inzending van {when} openen',
    'forms.answers.anonymous': 'Anoniem',
    'forms.answers.drawer_title': 'Inzending',
    'forms.answers.drawer_submitted': 'Verstuurd {when}',
    'forms.answers.drawer_by': 'door {name}',
    'forms.answers.drawer_unanswered': 'Niet beantwoord',
    'forms.answers.drawer_open_row': 'In de tabel openen',
    'forms.answers.drawer_open_run': 'Run openen',
    'forms.answers.all_title': 'Alle inzendingen',
    'forms.answers.all_export': 'Exporteren (CSV)',
    'forms.answers.all_open_table': 'Tabel openen',
    'forms.answers.all_filtered': 'Alleen de inzendingen die "{label}" hebben beantwoord.',
    'forms.answers.all_clear': 'Alle inzendingen tonen',
    'forms.answers.export_failed': 'De inzendingen konden niet worden geëxporteerd.',
    'forms.answers.empty_title': 'Nog geen inzendingen',
    'forms.answers.empty_body': 'Deel de link — het eerste antwoord verschijnt hier zodra het is verstuurd.',
    'forms.answers.empty_cta': 'Link kopiëren',
    'forms.answers.load_failed': 'De antwoorden konden niet worden geladen.',
    'forms.answers.retry': 'Opnieuw proberen',
    'forms.answers.no_table_title': 'Geen antwoordentabel',
    'forms.answers.no_table_body': 'Dit formulier start een automatisering en verzamelt zijn antwoorden niet in een tabel.',

    // ── a form's closing page: keep the result (BFSF-419) ───────────────
    'forms.result.download_txt': 'Downloaden als .txt',
    'forms.result.download_docx': 'Downloaden als Word',
    'forms.result.download_pdf': 'Downloaden als PDF',
    'forms.result.preparing': 'Wordt voorbereid…',
    'forms.result.copy': 'Tekst kopiëren',
    'forms.result.copied': 'Gekopieerd',
    'forms.result.save_notebook': 'Opslaan in een notitieboek',
    'forms.result.save_webpage': 'Opslaan als webpagina',
    'forms.result.saving': 'Wordt opgeslagen…',
    'forms.result.failed': 'Dat is niet gelukt. Probeer het opnieuw.',
    'forms.result.start_again': 'Opnieuw beginnen',

    // ── the Datatables side (`datatables.frm_*`) ────────────────────────
    'datatables.frm_kindchip': 'antwoorden van een formulier',
    'datatables.frm_open_form': 'Formulier openen',
    'datatables.frm_columns_locked': 'Deze kolommen zijn de vragen op het formulier. Voeg vragen toe, hernoem of verwijder ze op het formulier — de tabel volgt. Een kolom waarvan de vraag is verwijderd blijft hier staan, gemarkeerd als "niet meer op het formulier", en kan vanaf dit tabblad worden verwijderd.',
    'datatables.frm_column_hint': 'van het formulier · {label}',
    'datatables.frm_column_retired': 'niet meer op het formulier · {label}',
    'datatables.frm_hint_run_id': 'vast · de run die de inzending startte',
    'datatables.frm_hint_completed_at': 'vast · wanneer de laatste pagina is beantwoord',
    'datatables.frm_remove_retired': '{name} verwijderen',
    'datatables.frm_remove_retired_title': 'De kolom "{name}" verwijderen?',
    'datatables.frm_remove_retired_body': 'De antwoorden erin, in {n} rijen, worden definitief verwijderd. Het formulier verandert niet — de vraag staat er al niet meer op.',
    'datatables.frm_remove_retired_confirm': 'Kolom verwijderen',
    'datatables.frm_err_remove': 'De kolom kon niet worden verwijderd.',
    'datatables.frm_delete_notice': 'Deze tabel bevat de antwoorden op een formulier. De tabel verwijderen verwijdert elk antwoord; het formulier blijft bestaan en stopt met verzamelen.',
    'datatables.managed_definition_owned': 'De kolommen van deze tabel komen van het formulier.',
};

/** Keys whose Dutch IS the English string (see the sibling files for why). */
const SAME_AS_ENGLISH = [
    'forms.status.live',
    'forms.answers.timeline_week',
    'forms.answers.drawer_run_id',
    'forms.settings.live_title',
    'datatables.frm_tab_dashboard',
];

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-forms-answers-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
