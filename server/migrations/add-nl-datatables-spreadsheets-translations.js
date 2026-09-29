#!/usr/bin/env node
/**
 * Dutch for the spreadsheet-file half of the Datatables section (2026-09) —
 * and for the kind-agnostic `src_*` sentences both mirror kinds share.
 *
 * Its own catalogue beside add-nl-datatables-translations.js and
 * add-nl-datatables-nextcloud-translations.js rather than a widening of
 * either: the base file's test pins "every English datatables.* key has a
 * Dutch one" over the UNION of the catalogues, so a key can live in any of
 * them without the guard weakening — while the feature this one belongs to
 * (core/dataEngine/sources/spreadsheetFile) ships as one piece. The `src_*`
 * Dutch lives here because this change introduces those keys; the Nextcloud
 * catalogue keeps every `nc_*` key it had (ADD, NEVER RENAME — a renamed key
 * is a screen that silently falls back to English, and a workspace that
 * curated the Nextcloud wording keeps it).
 *
 * Terminology: a datatable is a "datatabel", the file a "spreadsheet", a
 * sheet in it a "werkblad", the header row the "kopregel", the key column
 * the "sleutelkolom", a row's number its "rijnummer", the storage it lives
 * in de "opslag"; a refresh is "verversen", linking "koppelen" and undoing
 * it "ontkoppelen" (never "verwijderen" — the file stays exactly as it is,
 * and the word must not threaten otherwise). And "dit account", never
 * "jij", for the reason the sibling files state.
 *
 * Structure: one section per surface, so the link wizard's keys (the next
 * stage) append as a section of their own at the end of NL_TRANSLATIONS.
 *
 * Idempotent, ADD NEVER RENAME, auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-datatables-spreadsheets-translations.js
 */

const NL_TRANSLATIONS = {
    // ── Gedeeld door beide spiegelsoorten: {source} is "Nextcloud" of de opslag ─
    'datatables.src_status_title': 'In de pas met {source}',
    'datatables.src_status_live': 'Live · in de pas met {source}',
    'datatables.src_status_running': 'Wordt ververst uit {source}…',
    'datatables.src_linked_by': '{source} wordt gelezen en geschreven als het account dat deze tabel gekoppeld heeft.',
    'datatables.src_open_in': 'Openen in {source}',
    'datatables.src_strip_write': 'Rijen die je hier wijzigt, wijzig je in {source}.',
    'datatables.src_writing': 'Wordt naar {source} geschreven…',
    'datatables.src_required': 'verplicht in {source}',
    'datatables.src_columns_locked': 'Deze kolommen komen uit {source} en kunnen hier niet worden toegevoegd, verwijderd, hernoemd of van type veranderd. Wijzig ze in {source} — de volgende verversing brengt ze hierheen.',
    'datatables.src_column_hint': 'uit {source}',
    'datatables.src_chip_from': 'uit {source}',
    'datatables.src_relations_empty': 'Nog geen relaties. Koppel een tweede tabel uit {source}, of uit een andere bron, en match een kolom van elk.',

    // ── De vierde kaart in de nieuwe-tabel-dialoog ──────────────────────────
    'datatables.kind_spreadsheet': 'Een spreadsheet uit je bestanden',
    'datatables.kind_spreadsheet_blurb': 'Een kopie van een werkblad in Google Drive, OneDrive of Nextcloud, die in de pas blijft met het bestand. Rijen die je hier wijzigt, worden naar het bestand geschreven; de kolommen zijn de kopregel van het werkblad.',
    'datatables.ss_linked_body': '{n} tabellen worden nu uit de bestanden gevuld. Routines en apps kunnen ze gebruiken als elke andere tabel.',
    'datatables.ss_linked_body_one': 'De tabel wordt nu uit het bestand gevuld. Routines en apps kunnen hem gebruiken als elke andere tabel.',
    'datatables.ss_the_storage': 'de opslag',

    // ── Bestandsindelingen ──────────────────────────────────────────────────
    'datatables.ss_format_xlsx': 'Excel-werkmap (.xlsx)',
    'datatables.ss_format_xlsm': 'Excel-werkmap met macro’s (.xlsm)',
    'datatables.ss_format_xls': 'Excel 97–2003-werkmap (.xls)',
    'datatables.ss_format_csv': 'CSV-bestand',
    'datatables.ss_format_ods': 'OpenDocument-spreadsheet (.ods)',
    'datatables.ss_format_gsheet': 'Google-spreadsheet',

    // ── Het Spreadsheet-tabblad: status, bestand, schrijven, identiteit ─────
    'datatables.ss_live_explain': 'Wijzigingen in het bestand verschijnen hier binnen seconden zolang de tabel openstaat; op de achtergrond wordt het bestand elke minuut gecontroleerd. Alleen de versie van het bestand wordt gecontroleerd — het wordt pas opnieuw gelezen als het veranderd is.',
    'datatables.ss_truncated': 'Niet elke rij is gekopieerd — de kopie is begrensd op {n} rijen. Splits het werkblad, of koppel een kleiner werkblad.',
    'datatables.ss_file_title': 'Het bestand',
    'datatables.ss_file_path': 'Pad',
    'datatables.ss_file_format': 'Indeling',
    'datatables.ss_file_where': 'Opgeslagen in',
    'datatables.ss_file_sheet': 'Werkblad: {sheet}',
    'datatables.ss_file_header_row': 'Kopregel: {n}',
    'datatables.ss_file_changed': 'Bestand voor het laatst gewijzigd {when}',
    'datatables.ss_relink': 'Kolommen opnieuw inlezen',
    'datatables.ss_relink_done': 'De kopregel en de toegang tot het bestand zijn opnieuw ingelezen; nieuwe kolommen komen bij de volgende verversing binnen.',
    'datatables.ss_readonly_title': 'Rijen worden uit het bestand gelezen',
    'datatables.ss_write_sheets_api': 'Rijen die je hier toevoegt, wijzigt of verwijdert worden eerst cel voor cel naar de Google-spreadsheet geschreven; daarna wordt deze kopie ververst uit wat het werkblad antwoordde. Weigert het werkblad een wijziging, dan zie je dat hier en verandert er aan geen van beide kanten iets.',
    'datatables.ss_write_graph_workbook': 'Rijen die je hier toevoegt, wijzigt of verwijdert worden eerst cel voor cel in de Excel-werkmap in OneDrive geschreven, zodat de opmaak behouden blijft; daarna wordt deze kopie ververst uit wat de werkmap antwoordde.',
    'datatables.ss_write_exceljs_put': 'Rijen die je hier toevoegt, wijzigt of verwijdert worden eerst in het bestand in {source} geschreven. Celstijlen, kolombreedtes en getalnotaties blijven behouden; grafieken, draaitabellen en macro’s niet. Is het bestand intussen veranderd, dan wordt er niets geschreven en wordt de rij ververst.',
    'datatables.ss_write_csv_put': 'Rijen die je hier toevoegt, wijzigt of verwijdert herschrijven eerst het hele CSV-bestand in {source} — met hetzelfde scheidingsteken, dezelfde tekencodering en dezelfde regeleinden als aangetroffen. Is het bestand intussen veranderd, dan wordt er niets geschreven en wordt de rij ververst.',
    'datatables.ss_write_none': 'Rijen van deze tabel worden uit het bestand gelezen; ze kunnen hier niet worden gewijzigd. Wijzig ze in het bestand — de volgende verversing brengt ze hierheen.',
    'datatables.ss_write_reason_xls': 'Een Excel 97–2003-bestand (.xls) wordt hier gelezen maar niet geschreven. Sla het op als .xlsx om rijen terug te schrijven.',
    'datatables.ss_write_reason_xlsm': 'Een werkmap met macro’s (.xlsm) wordt hier gelezen maar niet geschreven — schrijven zou de macro’s kwijtraken. Sla een kopie op als .xlsx om rijen terug te schrijven.',
    'datatables.ss_write_reason_ods': 'Een OpenDocument-spreadsheet (.ods) wordt hier gelezen maar niet geschreven. Sla het op als .xlsx om rijen terug te schrijven.',
    'datatables.ss_write_reason_not_owned': 'Het bestand is van iemand anders. Rijen worden hier gelezen; schrijven in een gedeeld bestand wordt per bestand aangezet door het account dat het koppelt.',
    'datatables.ss_write_reason_no_permission': 'Het account dat deze tabel gekoppeld heeft, mag het bestand niet wijzigen.',
    'datatables.ss_shared_write_on': 'Het bestand is van iemand anders. Het account dat deze tabel gekoppeld heeft, heeft ervoor gekozen er toch rijen in te schrijven; rijen die hier veranderen, komen in de opslag van die ander terecht.',
    'datatables.ss_columns_body': 'De kolommen zijn de kopregel van het werkblad. Wijzig ze in het bestand; “Kolommen opnieuw inlezen” brengt ze hierheen.',
    'datatables.ss_no_retention': 'Rijen worden hier niet opgeruimd — ze blijven zolang ze in het bestand staan.',
    'datatables.ss_identity_title': 'Hoe rijen herkend worden',
    'datatables.ss_identity_key': 'Elke rij wordt herkend aan zijn {column}. Een rij houdt hier zijn plaats als er in het werkblad rijen worden ingevoegd of gesorteerd; een gewijzigde {column} telt als een nieuwe rij.',
    'datatables.ss_identity_rownum': 'Elke rij wordt herkend aan zijn rijnummer in het werkblad. Een rij erboven invoegen of verwijderen verschuift de rijen eronder — een routine die een rij-id bewaart, kan beter een sleutelkolom gebruiken.',
    'datatables.ss_strip_readonly': 'Rijen kunnen hier niet worden gewijzigd — wijzig ze in het bestand.',

    // ── Wat een schrijfmechanisme bewaart en kwijtraakt (wizard én paneel) ──
    'datatables.ss_caveat_sheets_api': 'Rijen worden cel voor cel in het werkblad geschreven; getalnotaties blijven behouden.',
    'datatables.ss_caveat_graph_workbook': 'Rijen worden cel voor cel in de werkmap geschreven; de opmaak blijft behouden.',
    'datatables.ss_caveat_exceljs_put': 'Celstijlen, kolombreedtes en getalnotaties blijven behouden als rijen worden teruggeschreven; grafieken, draaitabellen en macro’s in het bestand niet.',
    'datatables.ss_caveat_csv_put': 'Het hele bestand wordt herschreven als een rij verandert — met hetzelfde scheidingsteken, dezelfde tekencodering en dezelfde regeleinden als aangetroffen.',
    'datatables.ss_caveat_none': 'Dit bestand wordt hier gelezen; rijen kunnen niet vanuit Bee Flow worden gewijzigd.',

    // ── Kolommen ────────────────────────────────────────────────────────────
    'datatables.ss_column_key': 'uit {source} · de sleutelkolom waaraan een rij herkend wordt',

    // ── Ontkoppelen ─────────────────────────────────────────────────────────
    'datatables.ss_unlink_notice': 'Ontkoppelen haalt de kopie weg die hier wordt bijgehouden. Het bestand in {source}, en elke rij erin, blijft precies zoals het is. Routines en apps die deze tabel gebruiken, vinden hem niet meer.',

    // ── Weigeringen (core/dataEngine/sources/spreadsheetFile/errors.js) ──────
    'datatables.ss_err_provider_not_connected': '{source} is niet verbonden voor dit account. Verbind het onder Instellingen → Koppelingen.',
    'datatables.ss_err_provider_needs_reauth': 'De verbinding met {source} is verlopen. Vernieuw hem onder Instellingen → Koppelingen.',
    'datatables.ss_err_provider_integration_off': '{source} staat uit voor deze organisatie.',
    'datatables.ss_err_spreadsheet_forbidden': '{source} weigert deze wijziging: het account dat deze tabel gekoppeld heeft, mag het bestand niet wijzigen.',
    'datatables.ss_err_spreadsheet_not_found': 'Het bestand staat niet meer waar het stond in {source}. Ontkoppel deze tabel en koppel het bestand opnieuw vanaf de nieuwe plek.',
    'datatables.ss_err_sheet_missing': 'Het werkblad zit niet meer in het bestand. Ontkoppel deze tabel en koppel het gewenste werkblad.',
    'datatables.ss_err_spreadsheet_conflict': 'Het bestand is veranderd terwijl deze rij werd geschreven, dus er is niets gewijzigd. De rijen zijn ververst — probeer het opnieuw.',
    'datatables.ss_err_spreadsheet_locked': 'Het bestand is op dit moment vergrendeld door iemand anders. Probeer het zo nog eens.',
    'datatables.ss_err_already_linked': 'Dat werkblad is hier al gekoppeld.',
    'datatables.ss_err_key_duplicate': 'Er staat al een rij met die sleutel in het werkblad: {detail}',
    'datatables.ss_err_write_unsupported': 'Rijen van deze tabel worden uit het bestand gelezen en kunnen hier niet worden gewijzigd.',
    'datatables.ss_err_spreadsheet_too_large': 'Het bestand is te groot om hier in de pas te houden.',
    'datatables.ss_err_format_unsupported': 'Dit bestandstype kan niet worden gekoppeld.',
    'datatables.ss_err_header_missing': 'Die rij ziet er niet uit als een kopregel.',
    'datatables.ss_err_key_missing': 'De sleutelkolom is leeg voor deze rij, dus de rij is niet van de andere te onderscheiden.',
    'datatables.ss_err_key_not_unique': '“{header}” is niet uniek in het werkblad en kan een rij dus niet identificeren.',
    'datatables.ss_err_spreadsheet_rejected': 'Het bestand accepteerde de rij niet: {detail}',
    'datatables.ss_err_spreadsheet_unavailable': '{source} was niet bereikbaar, dus er is aan geen van beide kanten iets veranderd. Probeer het zo nog eens.',
    'datatables.ss_err_schema_from_source': 'De kolommen van deze tabel komen uit het bestand. Wijzig ze in het bestand — “Kolommen opnieuw inlezen” brengt ze hierheen.',
    'datatables.ss_err_mirror_no_retention': 'Rijen van een gekoppelde spreadsheet worden hier niet opgeruimd.',
    'datatables.ss_err_mirror_row_scope': 'Een gekoppelde spreadsheet kan niet worden beperkt tot ieders eigen rijen — elke rij is geschreven door het account dat hem gekoppeld heeft.',
    'datatables.ss_err_no_shared_root': '{source} heeft geen map “gedeeld met mij” om door te bladeren.',

    // ── De koppelwizard: bestanden, werkbladen, namen, relaties, controleren ──
    // De vierde kaart en de reden waarom een opslag uit staat
    'datatables.ss_footer': 'Namen en technische namen kies je per werkblad in de volgende stap.',
    'datatables.ss_choose': 'Bestanden kiezen…',
    'datatables.ss_reason_not_connected': '{source} is niet verbonden voor dit account. Verbind het onder Instellingen → Koppelingen.',
    'datatables.ss_reason_needs_reauth': 'De verbinding met {source} is verlopen. Vernieuw hem onder Instellingen → Koppelingen.',
    'datatables.ss_reason_integration_off': '{source} staat uit voor deze organisatie. Een beheerder kan het aanzetten onder Organisatie → Integraties.',
    'datatables.ss_reason_nc_scope_off': 'Bee Flow mag de Nextcloud-bestanden van dit account nog niet lezen. Kies mappen onder Instellingen → Koppelingen → Nextcloud.',
    'datatables.ss_reason_unavailable': '{source} kan op dit moment niet worden gebruikt.',
    // De dialoog zelf
    'datatables.ss_link_title': 'Spreadsheets uit je bestanden koppelen',
    'datatables.ss_step_files': 'Bestanden',
    'datatables.ss_step_sheets': 'Werkbladen & kolommen',
    'datatables.ss_link_submit_one': 'Het werkblad koppelen',
    'datatables.ss_link_submit': '{n} werkbladen koppelen',
    'datatables.ss_max_tables': 'Hoogstens {n} werkbladen kunnen in één keer worden gekoppeld.',
    // Stap 1: bestanden
    'datatables.ss_providers': 'Opslag',
    'datatables.ss_breadcrumb': 'Mappad',
    'datatables.ss_root': 'Alle bestanden',
    'datatables.ss_shared_root': 'Gedeeld met mij',
    'datatables.ss_shared_toggle': 'Gedeeld met mij',
    'datatables.ss_search': 'Zoek een spreadsheet',
    'datatables.ss_search_results': 'Zoekresultaten',
    'datatables.ss_files_list': 'Bestanden en mappen',
    'datatables.ss_loading': 'Map wordt gelezen…',
    'datatables.ss_refresh': 'Map opnieuw lezen',
    'datatables.ss_empty_folder': 'Geen spreadsheets in deze map.',
    'datatables.ss_empty_search': 'Niets gevonden voor “{q}”.',
    'datatables.ss_more': 'Meer tonen',
    'datatables.ss_file_meta': '{format} · gewijzigd {when}',
    'datatables.ss_linked_chip_one': '1 werkblad gekoppeld',
    'datatables.ss_linked_chip': '{n} werkbladen gekoppeld',
    'datatables.ss_selected_one': '1 bestand geselecteerd',
    'datatables.ss_selected_n': '{n} bestanden geselecteerd',
    'datatables.ss_unselect': '{name} deselecteren',
    'datatables.ss_connect_hint': 'Verbind het onder Instellingen → Koppelingen.',
    // Stap 2: werkbladen en kolommen
    'datatables.ss_sheets_intro': 'Vink de werkbladen aan die je wilt koppelen. Elk werkblad wordt een eigen tabel.',
    'datatables.ss_retry': 'Opnieuw proberen',
    'datatables.ss_sheet_hidden': 'verborgen',
    'datatables.ss_shared_write_optin': 'Ook rijen in dit gedeelde bestand schrijven',
    'datatables.ss_shared_write_optin_help': 'Het bestand is van iemand anders. Staat dit aan, dan komen rijen die je hier toevoegt of wijzigt in de opslag van die ander terecht; staat het uit, dan wordt het bestand alleen gelezen.',
    'datatables.ss_header_row': 'Kopregel',
    'datatables.ss_header_dec': 'Eén rij omhoog',
    'datatables.ss_header_inc': 'Eén rij omlaag',
    'datatables.ss_preview_caption': 'Eerste rijen van {sheet}',
    'datatables.ss_columns_list': 'Kolommen van {sheet}',
    'datatables.ss_type_of': 'Type van',
    'datatables.ss_samples': 'bijv. {samples}',
    'datatables.ss_blank_header': '(geen kopregel) → {key}',
    'datatables.ss_formula_col': 'formule · alleen-lezen',
    'datatables.ss_identity_legend': 'Hoe een rij herkend wordt',
    'datatables.ss_identity_rownum_option': 'Rijnummer (standaard)',
    'datatables.ss_identity_help': 'Een sleutelkolom houdt de identiteit van een rij vast als er in het werkblad rijen worden ingevoegd of gesorteerd; met het rijnummer verschuift een rij erboven invoegen de rijen eronder.',
    'datatables.ss_key_repeats': 'waarden herhalen zich',
    'datatables.ss_key_no_header': 'geen kopregel',
    'datatables.ss_key_type': 'alleen tekst of getal',
    'datatables.ss_warn_dup_headers': 'Dubbele kopregels krijgen een nummer: {keys}.',
    'datatables.ss_warn_blank_headers': '{n} kolommen hebben geen kopregel en zijn naar hun letter genoemd.',
    // Stap 3: namen
    'datatables.ss_names_identity_key': 'herkend aan {column}',
    'datatables.ss_names_identity_rownum': 'herkend aan het rijnummer',
    // Stap 4: relaties
    'datatables.ss_relations_intro': 'Een relatie geeft elke rij van het ene werkblad een koppeling naar één rij van een ander: match een kolom van elk.',
    'datatables.ss_relations_need_two': 'Selecteer minstens twee werkbladen om ze te relateren.',
    // Stap 5: controleren
    'datatables.ss_review_identity_key': 'sleutel: {column}',
    'datatables.ss_review_identity_rownum': 'rijnummer',
    'datatables.ss_review_note': 'De rijen worden op de achtergrond uit de bestanden gekopieerd en blijven ermee in de pas. Rijen die je hier wijzigt, worden naar het bestand geschreven.',
    'datatables.ss_review_readonly_note': 'Een of meer bestanden zijn hier alleen-lezen; hun rijen kunnen niet vanuit Bee Flow worden gewijzigd.',
};

/** Keys whose Dutch IS the English string (see the sibling file for why). */
const SAME_AS_ENGLISH = [
    'datatables.ss_tab',
    // "{file} › {sheet}" — two placeholders and a chevron; no word to translate.
    'datatables.ss_review_sheet',
];

async function up() {
    const languageStore = require('../stores/languageStore');
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-datatables-spreadsheets-translations applied (+${added} keys)`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS, SAME_AS_ENGLISH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('[Migration] add-nl-datatables-spreadsheets-translations failed:', e.message);
        process.exit(1);
    });
}
